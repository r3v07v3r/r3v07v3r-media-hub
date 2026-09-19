// The wire between a renderer running outside Electron and the backend it
// talks to (src/headless/bridge.ts on one end, the renderer's web transport on
// the other). It carries exactly what ipcRenderer carried — a request and its
// answer, a fire-and-forget, a push — as JSON text frames, and nothing more.
// Kept here, imported by both ends, so the two cannot drift apart.
//
// JSON rather than Electron's structured clone is a real narrowing: no Date,
// no Map, no typed arrays. Every payload the app sends today is already plain
// data (thumbnails travel as data: URLs), and a payload that is not would
// arrive visibly wrong rather than silently different.

/** Which of the app's two "windows" a connection is. The service layer pushes
 *  to the main window and to the player overlay separately (they are separate
 *  BrowserWindows on the desktop); a connection says which it is when it
 *  connects and receives only that window's pushes. */
export type BridgeScope = 'main' | 'overlay'

export function isBridgeScope(value: unknown): value is BridgeScope {
  return value === 'main' || value === 'overlay'
}

/** Where the WebSocket lives, on the same origin as the page. */
export const BRIDGE_PATH = '/bridge'

/** The backend adds this to index.html as it serves it. Its presence is how
 *  the page knows its own origin has a bridge on it; the very same files
 *  served by anything else are the backend-less build, and must behave so. */
export const BRIDGE_MARKER_NAME = 'r3-bridge'
export const BRIDGE_MARKER_META = `<meta name="${BRIDGE_MARKER_NAME}" content="ws" />`

// ---- renderer -> backend ---------------------------------------------------

export interface InvokeFrame {
  t: 'invoke'
  /** Echoed on the result. Unique per connection, never reused. */
  id: number
  channel: string
  args: unknown[]
}

export interface SendFrame {
  t: 'send'
  channel: string
  args: unknown[]
}

export type ClientFrame = InvokeFrame | SendFrame

// ---- backend -> renderer ---------------------------------------------------

export interface WelcomeFrame {
  t: 'welcome'
  /** Changes every time the backend starts. A page that reconnects and is
   *  told a different one is talking to a NEW backend: whatever it believed
   *  about a playback session or a party died with the old one. */
  bootNonce: string
}

export type ResultFrame =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }

export interface EventFrame {
  t: 'event'
  channel: string
  payload: unknown
}

export type BridgeFrame = WelcomeFrame | ResultFrame | EventFrame

/**
 * The arguments of a call, as they go on the wire.
 *
 * JSON turns `undefined` inside an array into `null`, and a handler written
 * `(event, options = {})` treats those two very differently. Every call in the
 * API passes at most one payload, so the only `undefined` that ever appears is
 * a trailing "no payload given" — dropped here, it arrives as a genuinely
 * absent argument, exactly as it does over Electron IPC.
 */
export function wireArgs(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end)
}
