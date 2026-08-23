// Talks to the local Ollama instance — the one the person set up in
// Settings, or the one already running on this machine — and registers the
// IPC the AI features call. The pure half — address/model validation,
// prompt construction, reply parsing — lives in shared/media-hub/ollama.ts
// and is unit-tested there; this file is the sockets, the settings
// reads/writes, and the error messages.
//
// One address is tried without being asked: Ollama's own default,
// 127.0.0.1:11434 (see detectOllama below). Making someone open Settings to
// type a constant that is right on virtually every install is a setup step
// that teaches nothing, and the AI features sat visibly dead until they did
// it. The look is a single GET to loopback — this machine, where they have
// already chosen what runs — and it stops for good the moment they press
// Disconnect.
//
// What has not changed: there is still no fallback to a hosted model, and
// nothing is sent anywhere but the address in front of you. An app whose AI
// features only work against a model you installed yourself should not be
// quietly reaching anywhere else.

import type { WebContents } from 'electron'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  OllamaAskResult,
  OllamaRecommendResult,
  OllamaStatus
} from '../../shared/media-hub/types'
import {
  buildAssistantMessages,
  buildRecommendationMessages,
  effectiveOllamaBaseUrl,
  matchRecommendation,
  parseAssistantAnswer,
  normalizeOllamaBaseUrl,
  normalizeOllamaModel,
  parseOllamaModels,
  parseOllamaReply,
  pickInstalledModel,
  resolveOllamaConfig,
  type OllamaEndpoint,
  type OllamaMessage,
  type OllamaTitleRef,
  type SavedOllamaConfig
} from '../../shared/media-hub/ollama'
import { handle } from './ipcGuard'
import { sendToRenderer } from './rendererBridge'
import { readSettings, writeSettings } from './settingsStore'

/** Listing installed models is a local directory read on the server's side — if it hasn't answered in a few seconds, it isn't there. */
const PROBE_TIMEOUT_MS = 6000

/** Generation is a different order of magnitude: a large model on a CPU-only
 *  machine can genuinely take a minute to answer, and cutting that off would
 *  make the feature look broken on exactly the setups it most needs to work
 *  on. The UI shows a working state throughout. */
const GENERATE_TIMEOUT_MS = 120000

export type OllamaConfig = OllamaEndpoint

/** The address + model + off-switch as actually written in the settings file, all re-normalized on read. Either string may be ''. */
function savedConfig(): SavedOllamaConfig {
  const settings = readSettings()
  return {
    baseUrl: normalizeOllamaBaseUrl(settings.ollamaBaseUrl),
    model: normalizeOllamaModel(settings.ollamaModel),
    autoDetect: settings.ollamaAutoDetect !== false
  }
}

/** The address to talk to, before any question of which model — see effectiveOllamaBaseUrl, which is where that rule lives. */
function effectiveBaseUrl(saved = savedConfig()): string {
  return effectiveOllamaBaseUrl(saved)
}

/**
 * What the last look at the effective address found, or null if it found
 * nothing usable.
 *
 * Memory only, never written to the settings file, and deliberately so. A
 * detected pair is a fact about right now — which server answered, what it
 * had installed a moment ago — and writing it down would freeze a model
 * choice nobody made, so an `ollama rm` later would leave the app asking
 * for something that no longer exists. Looking again each run costs one GET
 * to loopback and corrects itself instead. Anything the person actually
 * chose is saved, and always wins over this.
 */
let detected: OllamaConfig | null = null

/** A look already in flight, so several callers asking at once share one request instead of each opening their own. */
let detecting: Promise<void> | null = null

/** When the last look finished, for the cooldown below. 0 means never. */
let detectedAt = 0

/**
 * How long a "nothing there" answer stands before it is worth asking again.
 *
 * There has to be some looking again: starting the app before starting
 * Ollama is an ordinary order to do things in, and without this the AI
 * features would stay dead until the next restart. There also has to be a
 * floor, because the alternative is a probe per question asked — and
 * against an address that black-holes rather than refuses, that is a
 * six-second stall in front of an answer the app already knows.
 */
const DETECT_COOLDOWN_MS = 15000

/**
 * Records what a probe of `baseUrl` saw, and tells the renderer when that
 * changed whether a model is connected at all.
 *
 * The renderer gates every AI surface on `ollamaConnected` out of the
 * settings snapshot it reads once on mount. A look can easily land after
 * that — it is a network round trip racing a React tree — so "one was
 * found" has to be pushed, or the assistant would go on saying nothing is
 * connected with a model sitting ready behind it.
 */
function rememberDetection(baseUrl: string, models: string[]): void {
  // Recorded without asking whether it is still wanted — ollamaConfig
  // decides that on the way out, so a probe that landed after a Disconnect
  // can write here and still change nothing. The broadcast below is
  // computed from ollamaConfig at both ends, so it stays silent in exactly
  // that case too.
  const wasConnected = ollamaConnected()
  // A saved model is preferred whenever the server still has it, so a
  // half-configured install — address forgotten, model remembered — lands
  // on the one that was chosen rather than whatever sorts first.
  const model = pickInstalledModel(models, '', savedConfig().model)
  detected = model ? { baseUrl, model } : null
  detectedAt = Date.now()
  if (ollamaConnected() !== wasConnected) sendToRenderer(MEDIA_HUB_CHANNELS.ollamaChanged)
}

/**
 * Looks for an Ollama at the effective address and remembers what it found.
 *
 * Never throws and never reports: "there is nothing there" is the ordinary
 * answer on a machine without Ollama, not a failure worth putting in front
 * of anyone. Callers that need the outcome read ollamaConfig() afterwards.
 *
 * Skipped once both an address and a model are saved — there is nothing
 * left to fill in, and asking then could not change anything.
 */
export function detectOllama(force = false): Promise<void> {
  const saved = savedConfig()
  if (saved.baseUrl && saved.model) return Promise.resolve()

  const baseUrl = effectiveBaseUrl(saved)
  if (!baseUrl) {
    // Disconnected. Anything an earlier look found has to go with it, or
    // the AI features would carry on running off a server the person just
    // said to stop using.
    if (detected) {
      detected = null
      sendToRenderer(MEDIA_HUB_CHANNELS.ollamaChanged)
    }
    return Promise.resolve()
  }

  if (detecting) return detecting
  if (!force && detectedAt && Date.now() - detectedAt < DETECT_COOLDOWN_MS) return Promise.resolve()

  detecting = listModels(baseUrl)
    .catch(() => [] as string[])
    .then((models) => rememberDetection(baseUrl, models))
    .catch(() => {})
    .finally(() => {
      detecting = null
    })
  return detecting
}

/**
 * The address + model the AI features will actually use: whatever was
 * chosen in Settings, filled in from what was detected wherever it was not.
 *
 * Detection only ever fills a gap. A saved model is never replaced, and a
 * detected model is only ever paired with the address it was seen on — so a
 * saved LAN address is never handed the model list of the machine this app
 * happens to be running on.
 */
export function ollamaConfig(): OllamaConfig {
  return resolveOllamaConfig(savedConfig(), detected)
}

/** Whether the AI features have somewhere to go. Read by settings:get so the renderer can gate on it. */
export function ollamaConnected(): boolean {
  const config = ollamaConfig()
  return Boolean(config.baseUrl && config.model)
}

/**
 * ollamaConfig(), after giving a look a chance to run when nothing is
 * configured yet.
 *
 * This is what makes "open the app, then start Ollama" work: the look on
 * startup found nothing, and the next question asked is what finds it. The
 * cooldown in detectOllama keeps that from becoming a probe per question.
 */
async function resolveConfig(): Promise<OllamaConfig> {
  const config = ollamaConfig()
  if (config.baseUrl && config.model) return config
  await detectOllama()
  return ollamaConfig()
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

/**
 * Throws the message the person needs to see when there is genuinely
 * nothing to ask.
 *
 * Async because it looks first: an install with Ollama running and nothing
 * saved is a working setup, and refusing it without checking is the exact
 * dead end this whole path exists to remove. resolveConfig only actually
 * probes when nothing is configured and the cooldown has passed, so the
 * common cases — configured, or checked a moment ago — cost nothing.
 */
async function requireConfig(): Promise<OllamaConfig> {
  const config = await resolveConfig()
  if (!config.baseUrl || !config.model) {
    throw new Error(
      'No local model is connected. Start Ollama, or point R3 at one in Settings under AI.'
    )
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
 * Generations still running, by the request id the renderer minted for each
 * one, so `ollamaCancel` can abort one by name.
 *
 * This exists because dropping a superseded answer in the renderer is not
 * enough: the generation keeps running here for up to two minutes, on
 * hardware the person is sitting in front of. A dismissed question that
 * carries on pinning a local GPU — and leaves the replacement question
 * queued behind work nobody wants any more — is the single most noticeable
 * way this integration could waste someone's machine.
 *
 * Both surfaces use it. The assistant cancels when its panel closes or a
 * newer question replaces the old one; a recommendation cancels when the
 * panel that asked for it unmounts — which matters more than it sounds,
 * since that request ends by NAVIGATING. A stale one does not merely waste
 * cycles, it moves someone off the page they are on.
 */
const inFlight = new Map<string, AbortController>()

/**
 * Keys are scoped to the renderer that asked, because the ids themselves are
 * only unique within one.
 *
 * Both counters live in renderer memory and restart at 1 when a renderer is
 * created. On macOS that is not hypothetical: window-all-closed deliberately
 * does not quit (see main/index.ts), so closing the window destroys the
 * renderer while this process and this map live on, and `activate` builds a
 * fresh one whose very first question is `ask-1` again. Unscoped, that new
 * request would overwrite an orphaned `ask-1` — making the orphan
 * uncancellable while it kept a local GPU busy — and the orphan's own
 * cleanup would then delete the newcomer's entry, leaving IT uncancellable
 * too. One dead window would break cancellation for the next one.
 */
function requestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

/**
 * Registers a cancellable request, returning the signal to pass to the model
 * call and the cleanup to run when it settles.
 *
 * The cleanup only removes the entry if it is still the one this call put
 * there, so a late finisher can never evict a live request that reused its
 * key. Closing the renderer aborts whatever it still owns: nothing in a
 * destroyed window is going to want that answer, and a generation nobody is
 * waiting for keeps a local GPU busy for up to two minutes.
 */
function trackRequest(
  sender: WebContents,
  requestId: string
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const onDestroyed = (): void => controller.abort()
  sender.once('destroyed', onDestroyed)

  const key = requestId ? requestKey(sender.id, requestId) : ''
  if (key) inFlight.set(key, controller)

  return {
    signal: controller.signal,
    release: () => {
      if (key && inFlight.get(key) === controller) inFlight.delete(key)
      if (!sender.isDestroyed()) sender.off('destroyed', onDestroyed)
    }
  }
}

export function registerOllamaIpc(): void {
  // Probes whichever address is being asked about — the one passed in (the
  // Settings pane checking an address the person is still typing, before
  // anything is saved) or, with none passed, the one the AI features would
  // use, which on a fresh install is the default. Never throws: "can't
  // reach it" is the normal answer to this question, not an error, and the
  // pane needs to render that answer rather than a rejected promise.
  handle<{ baseUrl?: string } | undefined, OllamaStatus>(
    MEDIA_HUB_CHANNELS.ollamaStatus,
    async (_event, payload) => {
      const saved = savedConfig()
      const effective = effectiveBaseUrl(saved)
      const baseUrl = payload?.baseUrl ? normalizeOllamaBaseUrl(payload.baseUrl) : effective
      const current = ollamaConfig()
      const base: OllamaStatus = {
        connected: Boolean(current.baseUrl && current.model),
        baseUrl,
        model: current.model,
        reachable: false,
        models: []
      }
      if (!baseUrl) {
        return payload?.baseUrl
          ? { ...base, error: 'That address is not a valid http:// or https:// URL.' }
          : base
      }
      try {
        const models = await listModels(baseUrl)
        // This probe just answered the same question detectOllama asks, so
        // it counts as one: opening Settings on a machine that started
        // Ollama a minute ago should connect the AI features, not merely
        // list what is installed and wait to be told again.
        if (!saved.model && baseUrl === effective) rememberDetection(baseUrl, models)
        return { ...base, connected: ollamaConnected(), reachable: true, models }
      } catch (error) {
        if (!saved.model && baseUrl === effective) rememberDetection(baseUrl, [])
        return {
          ...base,
          connected: ollamaConnected(),
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
      // Choosing a server is the way back from Disconnect, so the off
      // switch is released here rather than needing its own control.
      delete settings.ollamaAutoDetect
      writeSettings(settings)
      // A saved pair outranks anything detected, but leaving a stale one
      // behind would resurrect the old server the moment this pair is
      // cleared again.
      detected = null
      detectedAt = 0
      return { connected: true, baseUrl, model, reachable: true, models }
    }
  )

  // Disconnect means "stop using a local model", not "forget this address":
  // with the default address being tried on its own, forgetting alone would
  // reconnect to the very same server within seconds and the button would
  // appear to do nothing. So it also records that the person turned this
  // off, and only pressing Connect turns it back on.
  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.ollamaDisconnect, () => {
    const settings = readSettings()
    delete settings.ollamaBaseUrl
    delete settings.ollamaModel
    settings.ollamaAutoDetect = false
    writeSettings(settings)
    detected = null
    detectedAt = 0
    return { ok: true }
  })

  // The question, plus the three lists that make the answer about THIS app
  // rather than about films in general: what the app's own search already
  // found for it, what this person has watched, and what else is on offer.
  // The search runs in the renderer and finishes before this is called —
  // main is not the one that knows what is on screen.
  handle<
    {
      question?: string
      library?: unknown
      matches?: unknown
      watched?: unknown
      requestId?: string
    },
    OllamaAskResult
  >(
    MEDIA_HUB_CHANNELS.ollamaAsk,
    async (event, payload) => {
      // Registered before ANY await, requireConfig included. That call can
      // spend the full probe timeout looking for a server on an
      // unconfigured install, and a cancel arriving in that window used to
      // find nothing in `inFlight` to abort — so closing the panel did
      // nothing, and the generation that detection then started ran on for
      // up to two minutes with its answer already discarded. There is no
      // point in this handler at which the request should be
      // uncancellable.
      const { signal, release } = trackRequest(
        event.sender,
        String(payload?.requestId ?? '').slice(0, 64)
      )

      try {
        const config = await requireConfig()
        const question = String(payload?.question ?? '')
          .trim()
          .slice(0, 2000)
        if (!question) throw new Error('Ask a question first.')

        // Abandoned while the config was being worked out. Checked rather
        // than left to chat() — which would abort the fetch immediately
        // anyway — so a question nobody is waiting for does not first get a
        // prompt built out of three sanitized title lists.
        if (signal.aborted) return { reply: '', cancelled: true }

        const raw = await chat(
          config,
          buildAssistantMessages(question, {
            matches: sanitizeTitles(payload?.matches),
            library: sanitizeTitles(payload?.library),
            watched: sanitizeTitles(payload?.watched)
          }),
          signal
        )
        const answer = parseAssistantAnswer(raw)
        // Judged on the prose alone. A model that returns nothing but a
        // SIMILAR line has not answered the question, and the renderer has
        // the search results to show either way — but silently rendering an
        // empty answer under them would read as the model having nothing to
        // say rather than having failed.
        if (!answer.text)
          throw new Error(`${config.model} came back with an empty answer. Try asking again.`)
        return { reply: answer.text, similar: answer.similar }
      } catch (error) {
        // A cancellation is not a failure and must not be logged as one by
        // ipcGuard — the person closed the panel or asked something else.
        if (isCancellation(error)) return { reply: '', cancelled: true }
        throw error
      } finally {
        release()
      }
    }
  )

  handle<{ requestId?: string }, { ok: true }>(
    MEDIA_HUB_CHANNELS.ollamaCancel,
    (event, payload) => {
      // Scoped to the sender, so one renderer can never cancel another's work.
      const requestId = String(payload?.requestId ?? '')
      inFlight.get(requestKey(event.sender.id, requestId))?.abort()
      return { ok: true }
    }
  )

  // Returns an empty id rather than throwing when the model picks something
  // that isn't on the list it was given: that is a bad answer, not a broken
  // connection, and the caller has a perfectly good non-AI pick to fall back
  // on. Anything that IS a broken connection still throws.
  handle<{ kindLabel?: string; candidates?: unknown; requestId?: string }, OllamaRecommendResult>(
    MEDIA_HUB_CHANNELS.ollamaRecommend,
    async (event, payload) => {
      // Registered first, for the same reason as ollamaAsk above:
      // resolveConfig can await a probe, and a request that cannot be
      // cancelled during that window is one that keeps generating after
      // the panel asking for it has gone.
      const { signal, release } = trackRequest(
        event.sender,
        String(payload?.requestId ?? '').slice(0, 64)
      )

      try {
        // Reported, not thrown, unlike the assistant's requireConfig(). The
        // assistant has nothing else to offer, so "no model connected" IS
        // its answer; this button has a working non-AI fallback, and the
        // renderer needs to be told to use it rather than shown a failure.
        // It matters because the renderer cannot answer this itself: its
        // settings snapshot can say "no model" while one has since been
        // started, so a click has to ask rather than assume.
        const config = await resolveConfig()
        if (!config.baseUrl || !config.model) {
          return { id: '', reason: '', unavailable: true }
        }
        const candidates = sanitizeTitles(payload?.candidates)
        if (!candidates.length) throw new Error('There is nothing to recommend from yet.')
        const kindLabel = String(payload?.kindLabel ?? 'title')
          .trim()
          .slice(0, 20)

        if (signal.aborted) return { id: '', reason: '', cancelled: true }

        const reply = await chat(
          config,
          buildRecommendationMessages(kindLabel || 'title', candidates),
          signal
        )
        const picked = matchRecommendation(reply, candidates)
        return picked ? { id: picked.match.id, reason: picked.reason } : { id: '', reason: '' }
      } catch (error) {
        // Not a failure: the panel that asked went away. Reported rather
        // than thrown so ipcGuard doesn't log it as an error.
        if (isCancellation(error)) return { id: '', reason: '', cancelled: true }
        throw error
      } finally {
        release()
      }
    }
  )
}
