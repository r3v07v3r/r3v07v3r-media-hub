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

/**
 * POSTs/GETs one Ollama endpoint and returns the parsed JSON body.
 *
 * Failure messages name the address on purpose: every way this can go wrong
 * is something on the person's own machine or network ("it isn't running",
 * "that's the wrong port", "the firewall is eating it"), and the address is
 * the piece of information that makes the difference between a fixable
 * message and a shrug.
 */
async function ollamaFetch<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`${baseUrl} did not answer in time.`)
    }
    throw new Error(`Couldn't reach an Ollama server at ${baseUrl}. Is it running?`)
  } finally {
    clearTimeout(timer)
  }

  const body = (await response.json().catch(() => ({}))) as T & { error?: unknown }
  if (!response.ok) {
    const detail =
      typeof body?.error === 'string' && body.error ? body.error : `HTTP ${response.status}`
    throw new Error(`Ollama refused that request: ${detail}`)
  }
  return body
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
async function chat(config: OllamaConfig, messages: OllamaMessage[]): Promise<string> {
  const body = await ollamaFetch<unknown>(
    config.baseUrl,
    '/api/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: false })
    },
    GENERATE_TIMEOUT_MS
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

  handle<{ question?: string; library?: unknown }, OllamaAskResult>(
    MEDIA_HUB_CHANNELS.ollamaAsk,
    async (_event, payload) => {
      const config = requireConfig()
      const question = String(payload?.question ?? '')
        .trim()
        .slice(0, 2000)
      if (!question) throw new Error('Ask a question first.')
      const reply = await chat(
        config,
        buildAssistantMessages(question, sanitizeTitles(payload?.library))
      )
      if (!reply)
        throw new Error(`${config.model} came back with an empty answer. Try asking again.`)
      return { reply }
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
