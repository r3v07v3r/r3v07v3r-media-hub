// Whether a local model can actually be asked right now — the one question
// every surface that depends on Ollama has to answer BEFORE it is drawn.
//
// The Recommend buttons used to render off the settings snapshot's
// `ollamaConnected`, which says a server address and model are SAVED and
// nothing about whether that server is up. With Ollama not running, Home
// offered two buttons whose only possible outcome was an error toast
// ("Couldn't reach an Ollama server at http://127.0.0.1:11434. Is it
// running?"). A control that cannot work is not shown; this is the probe
// that decides.
//
// One probe loop for however many surfaces ask, not one per surface: the
// dashboard asks (to give the hero the column the buttons sat in) and the
// buttons ask, and two components on the same screen should not each be
// polling the same port.

import { useSyncExternalStore } from 'react'

/** The floor between two probes a focus or a heartbeat would otherwise fire. */
const RECHECK_MIN_GAP_MS = 15_000
/** How often the pane re-asks while something that needs the answer is on
 *  screen, so an Ollama started AFTER Home opened shows up without a
 *  restart. Against a refused connection a probe costs nothing; against an
 *  address that black-holes, main's own timeout bounds it. */
const HEARTBEAT_MS = 60_000

let available = false
let lastAsked = 0
let inFlight: Promise<void> | null = null
let heartbeat: number | null = null
let unsubscribeChanged: (() => void) | null = null
const listeners = new Set<() => void>()

function publish(next: boolean): void {
  if (next === available) return
  available = next
  for (const listener of listeners) listener()
}

function probe(force = false): void {
  const api = window.api?.mediaHub?.ollama
  if (!api) {
    publish(false)
    return
  }
  if (!force && Date.now() - lastAsked < RECHECK_MIN_GAP_MS) return
  if (inFlight) return
  lastAsked = Date.now()
  inFlight = api
    .status()
    .then((status) => publish(Boolean(status.connected && status.reachable)))
    .catch(() => publish(false))
    .finally(() => {
      inFlight = null
    })
}

function onFocus(): void {
  probe()
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') probe()
}

function start(): void {
  probe(true)
  heartbeat = window.setInterval(() => probe(), HEARTBEAT_MS)
  // Main pushes this when a look of its own finds or loses a model (see
  // ollamaService.ts's rememberDetection) — the one case where waiting
  // for the heartbeat would be a minute of stale buttons.
  unsubscribeChanged = window.api?.mediaHub?.ollama?.onChanged(() => probe(true)) ?? null
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)
}

function stop(): void {
  if (heartbeat !== null) window.clearInterval(heartbeat)
  heartbeat = null
  unsubscribeChanged?.()
  unsubscribeChanged = null
  window.removeEventListener('focus', onFocus)
  document.removeEventListener('visibilitychange', onVisibility)
}

/**
 * True while an Ollama with a model is reachable at the address the AI
 * features use. False until the first probe answers — a surface that waits
 * for a yes draws nothing it would have to take back.
 */
export function useOllamaAvailable(): boolean {
  return useSyncExternalStore(subscribe, read)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

function read(): boolean {
  return available
}
