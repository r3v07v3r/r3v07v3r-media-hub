// window.api's transport when the renderer runs OUTSIDE Electron: the same
// three methods the preload builds over ipcRenderer (see preload/api.ts),
// built over a WebSocket to the backend on this page's own origin
// (src/headless/bridge.ts). The api object made from it is identical in shape
// to the desktop one, so nothing above this file knows which it has.
//
// What a socket adds that IPC never had to think about is that it can go away.
// Three things follow from that, and they are the whole of this file's
// difficulty:
//
//   - A call made while the link is down WAITS for it, briefly, instead of
//     failing: a page that loads a beat before its socket opens must not start
//     life with a screen of errors. A call already SENT when the link drops is
//     rejected at once — the backend may or may not have acted on it, and only
//     the caller can decide what that means.
//   - Subscriptions are the page's own bookkeeping (the backend pushes every
//     event for this window regardless), so they survive a reconnect with
//     nothing to redo — except the telemetry feed, whose start is a message
//     the backend has to be sent again.
//   - Coming back is not always coming back to the same backend. It names
//     itself on every connection; if the name changed, the process restarted,
//     and whatever this page believes about a playback session or a party
//     died with it. Patching each belief would be a guess. The page reloads
//     and asks again.

import type { ApiTransport } from '../../../preload/api'
import {
  BRIDGE_PATH,
  wireArgs,
  type BridgeFrame,
  type BridgeScope,
  type ClientFrame
} from '@shared/bridgeProtocol'

export type BridgeState = 'connecting' | 'open' | 'reconnecting'

export interface WebTransport extends ApiTransport {
  state(): BridgeState
  onStateChange(listener: (state: BridgeState) => void): () => void
}

/** How long a call made while the link is down waits for it to come back. */
const SEND_PATIENCE_MS = 15_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 8_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  channel: string
}

interface Queued {
  frame: ClientFrame
  /** Set for an invoke: what to reject if patience runs out first. */
  pendingId?: number
  timer?: ReturnType<typeof setTimeout>
}

export function createWebSocketTransport(scope: BridgeScope): WebTransport {
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${BRIDGE_PATH}?scope=${scope}`

  let socket: WebSocket | null = null
  let state: BridgeState = 'connecting'
  let bootNonce: string | null = null
  let nextId = 1
  let retryInMs = RECONNECT_MIN_MS

  const pending = new Map<number, Pending>()
  const queue: Queued[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const stateListeners = new Set<(state: BridgeState) => void>()
  /** Fire-and-forgets the backend must hear again after a reconnect — in
   *  practice, "start the telemetry feed". Keyed by what undoes them. */
  const standing = new Map<string, ClientFrame>()

  const setState = (next: BridgeState): void => {
    if (state === next) return
    state = next
    for (const listener of stateListeners) listener(next)
  }

  const transmit = (frame: ClientFrame): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  const flushQueue = (): void => {
    while (queue.length && socket?.readyState === WebSocket.OPEN) {
      const item = queue.shift() as Queued
      if (item.timer) clearTimeout(item.timer)
      transmit(item.frame)
    }
  }

  const enqueue = (frame: ClientFrame, pendingId?: number): void => {
    const item: Queued = { frame, pendingId }
    if (pendingId !== undefined) {
      item.timer = setTimeout(() => {
        const at = queue.indexOf(item)
        if (at >= 0) queue.splice(at, 1)
        const waiting = pending.get(pendingId)
        pending.delete(pendingId)
        waiting?.reject(
          new Error(`No connection to the backend ('${waiting.channel}' was never sent).`)
        )
      }, SEND_PATIENCE_MS)
    }
    queue.push(item)
  }

  const connect = (): void => {
    const ws = new WebSocket(url)
    socket = ws

    ws.onopen = () => {
      retryInMs = RECONNECT_MIN_MS
    }

    ws.onmessage = (message) => {
      let frame: BridgeFrame
      try {
        frame = JSON.parse(String(message.data)) as BridgeFrame
      } catch {
        return
      }
      if (frame.t === 'welcome') {
        if (bootNonce !== null && bootNonce !== frame.bootNonce) {
          // A different backend from the one this page was talking to.
          location.reload()
          return
        }
        bootNonce = frame.bootNonce
        for (const again of standing.values()) transmit(again)
        setState('open')
        flushQueue()
        return
      }
      if (frame.t === 'result') {
        const waiting = pending.get(frame.id)
        if (!waiting) return
        pending.delete(frame.id)
        if (frame.ok) waiting.resolve(frame.value)
        else waiting.reject(new Error(frame.error))
        return
      }
      if (frame.t === 'event') {
        for (const listener of listeners.get(frame.channel) ?? []) listener(frame.payload)
      }
    }

    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      setState('reconnecting')
      // Sent, and now never to be answered. Whatever is still in `queue` was
      // never sent and keeps waiting, on its own clock.
      const unsent = new Set(queue.map((item) => item.pendingId))
      for (const [id, waiting] of pending) {
        if (unsent.has(id)) continue
        pending.delete(id)
        waiting.reject(
          new Error(`The connection to the backend dropped during '${waiting.channel}'.`)
        )
      }
      setTimeout(connect, retryInMs)
      retryInMs = Math.min(retryInMs * 2, RECONNECT_MAX_MS)
    }

    // onclose always follows and does the work; this only stops the browser
    // logging an unhandled error event.
    ws.onerror = () => {}
  }

  connect()

  return {
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, channel })
        const frame: ClientFrame = { t: 'invoke', id, channel, args: wireArgs(args) }
        if (state !== 'open' || !transmit(frame)) enqueue(frame, id)
      })
    },

    on<T>(channel: string, listener: (payload: T) => void): () => void {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set)
      const erased = listener as (payload: unknown) => void
      set.add(erased)
      return () => {
        set.delete(erased)
        if (!set.size) listeners.delete(channel)
      }
    },

    send(channel: string, ...args: unknown[]): void {
      const frame: ClientFrame = { t: 'send', channel, args: wireArgs(args) }
      // `x:subscribe` stands until its `x:unsubscribe` — the one pair of
      // fire-and-forgets in the API (see preload/api.ts's system.subscribe).
      const stem = channel.replace(/:(un)?subscribe$/, '')
      const stands = channel.endsWith(':subscribe')
      if (stands) standing.set(stem, frame)
      else if (channel.endsWith(':unsubscribe')) standing.delete(stem)
      if (state === 'open' && transmit(frame)) return
      // A standing frame is re-sent on every welcome as it is; queueing it too
      // would deliver it twice.
      if (!stands) enqueue(frame)
    },

    state: () => state,

    onStateChange(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }
  }
}
