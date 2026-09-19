// The renderer's whole backend surface (src/preload/api.ts), built over a
// recording transport instead of Electron IPC. What this pins is the seam
// itself: every call goes through the injected transport and nowhere else,
// and only ever on a channel the backend declares.
// Run with: npx tsx tests/preloadApi.test.ts

import assert from 'node:assert/strict'

import { createApi, type ApiTransport } from '../src/preload/api'
import { IPC_CHANNELS } from '../src/shared/ipc-types'
import { MEDIA_HUB_CHANNELS } from '../src/shared/media-hub/ipc-channels'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

interface Call {
  kind: 'invoke' | 'on' | 'off' | 'send'
  channel: string
  args: unknown[]
}

function recordingTransport(): { transport: ApiTransport; calls: Call[] } {
  const calls: Call[] = []
  const transport: ApiTransport = {
    invoke: <T>(channel: string, ...args: unknown[]) => {
      calls.push({ kind: 'invoke', channel, args })
      return Promise.resolve(undefined as T)
    },
    on: (channel) => {
      calls.push({ kind: 'on', channel, args: [] })
      return () => calls.push({ kind: 'off', channel, args: [] })
    },
    send: (channel, ...args) => {
      calls.push({ kind: 'send', channel, args })
    }
  }
  return { transport, calls }
}

type Leaf = { path: string; fn: (...args: unknown[]) => unknown }

/** Every function in the api tree, with the dotted path it is reached by. */
function leaves(node: unknown, path: string[] = []): Leaf[] {
  if (typeof node === 'function') {
    return [{ path: path.join('.'), fn: node as Leaf['fn'] }]
  }
  if (!node || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([key, child]) => leaves(child, [...path, key]))
}

/** A subscription by the app's own naming: `subscribe`, or `onSomething`. */
const isSubscription = (path: string): boolean => /(^|\.)(subscribe|on[A-Z]\w*)$/.test(path)

const DECLARED = new Set<string>([
  ...Object.values(IPC_CHANNELS),
  ...Object.values(MEDIA_HUB_CHANNELS),
  // The telemetry feed's start/stop handshake — string literals on both sides
  // (see main/ipc/telemetry.ts), the only channels outside the two tables.
  'system:subscribe',
  'system:unsubscribe'
])

check('every api function reaches the backend through the transport, and only that', () => {
  const { transport, calls } = recordingTransport()
  const all = leaves(createApi(transport))
  // A floor, not an exact count: what it catches is the tree collapsing (a
  // namespace dropped in a refactor), not the surface growing.
  assert.ok(all.length >= 200, `expected the full surface, found ${all.length} functions`)

  for (const leaf of all) {
    const before = calls.length
    if (isSubscription(leaf.path)) leaf.fn(() => {})
    else void leaf.fn()
    assert.ok(calls.length > before, `${leaf.path} made no transport call`)
  }
})

check('only declared channels are ever used', () => {
  const { transport, calls } = recordingTransport()
  for (const leaf of leaves(createApi(transport))) {
    if (isSubscription(leaf.path)) leaf.fn(() => {})
    else void leaf.fn()
  }
  const unknown = [...new Set(calls.map((call) => call.channel))].filter(
    (channel) => !DECLARED.has(channel)
  )
  assert.deepEqual(unknown, [], `undeclared channels: ${unknown.join(', ')}`)
})

check('a request is one invoke carrying exactly the payload the handler reads', () => {
  const { transport, calls } = recordingTransport()
  const api = createApi(transport)

  void api.mediaHub.catalog.search('movie', 'in time')
  assert.deepEqual(calls.at(-1), {
    kind: 'invoke',
    channel: MEDIA_HUB_CHANNELS.catalogSearch,
    args: [{ kind: 'movie', query: 'in time' }]
  })

  // No payload means NO argument, not an explicit undefined: a handler that
  // counts its arguments must see the same call it always has.
  void api.mediaHub.bootstrap()
  assert.deepEqual(calls.at(-1), {
    kind: 'invoke',
    channel: MEDIA_HUB_CHANNELS.bootstrap,
    args: []
  })
})

check('a subscription listens on its channel and its unsubscribe stops it', () => {
  const { transport, calls } = recordingTransport()
  const api = createApi(transport)

  const stop = api.mediaHub.library.onChanged(() => {})
  assert.deepEqual(calls, [{ kind: 'on', channel: MEDIA_HUB_CHANNELS.libraryChanged, args: [] }])
  stop()
  assert.deepEqual(calls.at(-1), {
    kind: 'off',
    channel: MEDIA_HUB_CHANNELS.libraryChanged,
    args: []
  })
})

check('a pushed payload reaches the subscriber as-is', () => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = createApi({
    invoke: <T>() => Promise.resolve(undefined as T),
    on: <T>(channel: string, listener: (payload: T) => void) => {
      listeners.set(channel, listener as (payload: unknown) => void)
      return () => listeners.delete(channel)
    },
    send: () => {}
  })

  const seen: unknown[] = []
  api.mediaHub.player.onState((patch) => seen.push(patch))
  listeners.get(MEDIA_HUB_CHANNELS.playerState)?.({ paused: true })
  assert.deepEqual(seen, [{ paused: true }])
})

check('the telemetry feed asks to start, and asks to stop before it stops listening', () => {
  const { transport, calls } = recordingTransport()
  const stop = createApi(transport).system.subscribe(() => {})
  stop()
  assert.deepEqual(
    calls.map((call) => `${call.kind} ${call.channel}`),
    [
      `on ${IPC_CHANNELS.systemSnapshot}`,
      'send system:subscribe',
      'send system:unsubscribe',
      `off ${IPC_CHANNELS.systemSnapshot}`
    ]
  )
})

console.log(`\n${pass} passed`)
