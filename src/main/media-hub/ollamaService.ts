// Talks to the local Ollama instance the person set up in Settings, and
// registers the IPC the AI features call. The pure half — address/model
// validation, prompt construction, reply parsing — lives in
// shared/media-hub/ollama.ts and is unit-tested there; this file is the
// sockets, the settings reads/writes, and the error messages.
//
// Nothing here runs unless the person has both saved an address and picked
// a model. There is no default instance, no probing of localhost behind
// their back, and no fallback to a hosted model: an app whose AI features
// only work against a model you installed yourself should not be quietly
// reaching anywhere else.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  OllamaAskResult,
  OllamaRecommendResult,
  OllamaStatus
} from '../../shared/media-hub/types'
import {
  buildAssistantMessages,
  buildRecommendationMessages,
  matchRecommendation,
  normalizeOllamaBaseUrl,
  normalizeOllamaModel,
  parseOllamaModels,
  parseOllamaReply,
  type OllamaMessage,
  type OllamaTitleRef
} from '../../shared/media-hub/ollama'
import { handle } from './ipcGuard'
import { readSettings, writeSettings } from './settingsStore'

/** Listing installed models is a local directory read on the server's side — if it hasn't answered in a few seconds, it isn't there. */
const PROBE_TIMEOUT_MS = 6000

/** Generation is a different order of magnitude: a large model on a CPU-only
 *  machine can genuinely take a minute to answer, and cutting that off would
 *  make the feature look broken on exactly the setups it most needs to work
 *  on. The UI shows a working state throughout. */
const GENERATE_TIMEOUT_MS = 120000

export interface OllamaConfig {
  baseUrl: string
  model: string
}

/** The saved address + model, both re-normalized on read. Either may be ''. */
export function ollamaConfig(): OllamaConfig {
  const settings = readSettings()
  return {
    baseUrl: normalizeOllamaBaseUrl(settings.ollamaBaseUrl),
    model: normalizeOllamaModel(settings.ollamaModel)
  }
}

/** Whether the AI features have somewhere to go. Read by settings:get so the renderer can gate on it. */
export function ollamaConnected(): boolean {
  const config = ollamaConfig()
  return Boolean(config.baseUrl && config.model)
}

/** Thrown when a request was deliberately abandoned by the renderer (see `ollamaCancel`) rather than failing. Never shown to anyone. */
class OllamaCancelledError extends Error {
  constructor() {
    super('Request cancelled.')
    this.name = 'OllamaCancelledError'
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof OllamaCancelledError
}

/**
 * POSTs/GETs one Ollama endpoint and returns the parsed JSON body.
 *
 * Failure messages name the address on purpose: every way this can go wrong
 * is something on the person's own machine or network ("it isn't running",
 * "that's the wrong port", "the firewall is eating it"), and the address is
 * the piece of information that makes the difference between a fixable
 * message and a shrug.
 *
 * The timeout covers reading the response body, not just getting a reply to
 * the request. fetch() resolves as soon as the headers land, so a server (or
 * a reverse proxy in front of one) that answers and then stalls partway
 * through its JSON would otherwise hold the read open indefinitely with the
 * timer already cleared — six seconds and two minutes would both mean
 * nothing, and Settings or an AI panel would sit in its busy state forever.
 */
async function ollamaFetch<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = (): void => {
    cancelled = true
    controller.abort()
  }
  if (externalSignal?.aborted) onExternalAbort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  // Distinguishes the three ways this can end early, since they are three
  // different things to say (or not say) to the person: they gave up on the
  // answer, the server went quiet, or it was never there.
  const describe = (error: unknown, stalled: string): Error => {
    if (cancelled) return new OllamaCancelledError()
    if (timedOut || (error as Error)?.name === 'AbortError') return new Error(stalled)
    return new Error(`Couldn't reach an Ollama server at ${baseUrl}. Is it running?`)
  }

  try {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal })
    } catch (error) {
      throw describe(error, `${baseUrl} did not answer in time.`)
    }

    let body: T & { error?: unknown }
    try {
      body = (await response.json()) as T & { error?: unknown }
    } catch (error) {
      if (cancelled || timedOut || (error as Error)?.name === 'AbortError') {
        throw describe(error, `${baseUrl} stopped responding partway through its answer.`)
      }
      // A body that simply isn't JSON is tolerated as an empty object, same
      // as before — that is a badly-behaved endpoint, not a stalled one, and
      // the status check below still has the last word.
      body = {} as T & { error?: unknown }
    }

    if (!response.ok) {
      const detail =
        typeof body?.error === 'string' && body.error ? body.error : `HTTP ${response.status}`
      throw new Error(`Ollama refused that request: ${detail}`)
    }
    return body
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** Installed model tags at `baseUrl`. Throws with a readable reason if the server isn't reachable. */
async function listModels(baseUrl: string): Promise<string[]> {
  return parseOllamaModels(
    await ollamaFetch<unknown>(baseUrl, '/api/tags', { method: 'GET' }, PROBE_TIMEOUT_MS)
  )
}

/**
 * One non-streaming chat round trip.
 *
 * `stream: false` because every caller here wants a whole answer to show at
 * once — the assistant panel and a recommendation are both single results,
 * not a typewriter. Streaming would mean a push channel per request and a
 * partial-answer state in the renderer for no gain at these lengths.
 */
async function chat(
  config: OllamaConfig,
  messages: OllamaMessage[],
  signal?: AbortSignal
): Promise<string> {
  const body = await ollamaFetch<unknown>(
    config.baseUrl,
    '/api/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: false })
    },
    GENERATE_TIMEOUT_MS,
    signal
  )
  return parseOllamaReply(body)
}

/** Throws the message the person needs to see when nothing is set up yet. Every generation handler starts here. */
function requireConfig(): OllamaConfig {
  const config = ollamaConfig()
  if (!config.baseUrl || !config.model) {
    throw new Error('No local model is connected. Add one in Settings under AI.')
  }
  return config
}

/** Trims a renderer-supplied title list down to what a prompt should carry, dropping anything malformed. */
function sanitizeTitles(value: unknown): OllamaTitleRef[] {
  if (!Array.isArray(value)) return []
  const titles: OllamaTitleRef[] = []
  for (const entry of value) {
    const id = String((entry as OllamaTitleRef)?.id ?? '').trim()
    const title = String((entry as OllamaTitleRef)?.title ?? '')
      .trim()
      .slice(0, 200)
    if (!id || !title) continue
    const year = Number((entry as OllamaTitleRef)?.year)
    const genres = (entry as OllamaTitleRef)?.genres
    titles.push({
      id,
      title,
      year: Number.isFinite(year) && year > 1800 ? year : undefined,
      genres: Array.isArray(genres)
        ? genres.map((g) => String(g).slice(0, 40)).slice(0, 5)
        : undefined
    })
  }
  return titles
}

/**
 * Assistant generations still running, by the request id the renderer minted
 * for each one, so `ollamaCancel` can abort one by name.
 *
 * This exists because dropping a superseded answer in the renderer is not
 * enough: the generation keeps running here for up to two minutes, on
 * hardware the person is sitting in front of. A dismissed question that
 * carries on pinning a local GPU — and leaves the replacement question
 * queued behind work nobody wants any more — is the single most noticeable
 * way this integration could waste someone's machine.
 *
 * Only the assistant is cancellable. A recommendation has no dismiss
 * affordance (its button is disabled until it returns), so there is nothing
 * that could ask to abandon one.
 */
const inFlightAsks = new Map<string, AbortController>()

export function registerOllamaIpc(): void {
  // Probes whichever address is being asked about — the one passed in (the
  // Settings pane checking an address the person is still typing, before
  // anything is saved) or the saved one. Never throws: "can't reach it" is
  // the normal answer to this question, not an error, and the pane needs to
  // render that answer rather than a rejected promise.
  handle<{ baseUrl?: string } | undefined, OllamaStatus>(
    MEDIA_HUB_CHANNELS.ollamaStatus,
    async (_event, payload) => {
      const saved = ollamaConfig()
      const baseUrl = payload?.baseUrl ? normalizeOllamaBaseUrl(payload.baseUrl) : saved.baseUrl
      const base: OllamaStatus = {
        connected: Boolean(saved.baseUrl && saved.model),
        baseUrl,
        model: saved.model,
        reachable: false,
        models: []
      }
      if (!baseUrl) {
        return payload?.baseUrl
          ? { ...base, error: 'That address is not a valid http:// or https:// URL.' }
          : base
      }
      try {
        return { ...base, reachable: true, models: await listModels(baseUrl) }
      } catch (error) {
        return {
          ...base,
          error: error instanceof Error ? error.message : 'Could not reach Ollama.'
        }
      }
    }
  )

  // Saves only after checking the server is actually there and actually has
  // the model — a settings pane that accepts anything and fails later at the
  // point of use is how people end up thinking the AI features are broken.
  handle<{ baseUrl?: string; model?: string }, OllamaStatus>(
    MEDIA_HUB_CHANNELS.ollamaConnect,
    async (_event, payload) => {
      const baseUrl = normalizeOllamaBaseUrl(payload?.baseUrl)
      if (!baseUrl)
        throw new Error('Enter the address of your Ollama server, e.g. http://127.0.0.1:11434')
      const model = normalizeOllamaModel(payload?.model)
      if (!model) throw new Error('Choose which installed model to use.')

      const models = await listModels(baseUrl)
      if (!models.length) {
        throw new Error(
          `${baseUrl} answered, but has no models installed. Pull one first, e.g. "ollama pull llama3.2".`
        )
      }
      if (!models.includes(model)) {
        throw new Error(
          `${baseUrl} has no model called "${model}". Installed: ${models.join(', ')}.`
        )
      }

      const settings = readSettings()
      settings.ollamaBaseUrl = baseUrl
      settings.ollamaModel = model
      writeSettings(settings)
      return { connected: true, baseUrl, model, reachable: true, models }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.ollamaDisconnect, () => {
    const settings = readSettings()
    delete settings.ollamaBaseUrl
    delete settings.ollamaModel
    writeSettings(settings)
    return { ok: true }
  })

  handle<{ question?: string; library?: unknown; requestId?: string }, OllamaAskResult>(
    MEDIA_HUB_CHANNELS.ollamaAsk,
    async (_event, payload) => {
      const config = requireConfig()
      const question = String(payload?.question ?? '')
        .trim()
        .slice(0, 2000)
      if (!question) throw new Error('Ask a question first.')

      const requestId = String(payload?.requestId ?? '').slice(0, 64)
      const controller = new AbortController()
      // Registered before the first await, so a cancel that arrives while
      // the model is still warming up finds something to abort.
      if (requestId) inFlightAsks.set(requestId, controller)

      try {
        const reply = await chat(
          config,
          buildAssistantMessages(question, sanitizeTitles(payload?.library)),
          controller.signal
        )
        if (!reply)
          throw new Error(`${config.model} came back with an empty answer. Try asking again.`)
        return { reply }
      } catch (error) {
        // A cancellation is not a failure and must not be logged as one by
        // ipcGuard — the person closed the panel or asked something else.
        if (isCancellation(error)) return { reply: '', cancelled: true }
        throw error
      } finally {
        if (requestId) inFlightAsks.delete(requestId)
      }
    }
  )

  handle<{ requestId?: string }, { ok: true }>(
    MEDIA_HUB_CHANNELS.ollamaCancel,
    (_event, payload) => {
      const requestId = String(payload?.requestId ?? '')
      inFlightAsks.get(requestId)?.abort()
      return { ok: true }
    }
  )

  // Returns an empty id rather than throwing when the model picks something
  // that isn't on the list it was given: that is a bad answer, not a broken
  // connection, and the caller has a perfectly good non-AI pick to fall back
  // on. Anything that IS a broken connection still throws.
  handle<{ kindLabel?: string; candidates?: unknown }, OllamaRecommendResult>(
    MEDIA_HUB_CHANNELS.ollamaRecommend,
    async (_event, payload) => {
      const config = requireConfig()
      const candidates = sanitizeTitles(payload?.candidates)
      if (!candidates.length) throw new Error('There is nothing to recommend from yet.')
      const kindLabel = String(payload?.kindLabel ?? 'title')
        .trim()
        .slice(0, 20)

      const reply = await chat(
        config,
        buildRecommendationMessages(kindLabel || 'title', candidates)
      )
      const picked = matchRecommendation(reply, candidates)
      return picked ? { id: picked.match.id, reason: picked.reason } : { id: '', reason: '' }
    }
  )
}
