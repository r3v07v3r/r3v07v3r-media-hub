// The far end of `window.api` when there is no Electron: one loopback HTTP
// server that hands the renderer its own files and, on the same origin, a
// WebSocket that carries what ipcRenderer carried. A request frame becomes a
// call into the very handler `ipcMain.handle` registered; a push from
// `webContents.send` becomes an event frame. The service layer cannot tell the
// difference, which is the point.
//
// Same origin for both on purpose: the renderer's CSP says `connect-src
// 'self'`, and that stays true without being loosened.
//
// WHO MAY CONNECT. On the desktop the answer is structural — only the app's own
// window has a preload. Here it has to be earned:
//   - bound to 127.0.0.1, never a routable address;
//   - a single-use launch code (printed by the host, in the URL it opens) is
//     exchanged for an HttpOnly, SameSite=Strict session cookie, then is dead —
//     so the secret that matters is never in a URL, never in page script, and
//     cannot be read by anything the page loads;
//   - every request must carry that cookie AND name this server in Host (which
//     is what stops another site rebinding its DNS to us);
//   - the WebSocket must also come from this origin, since a handshake is not
//     subject to CORS and any page may otherwise attempt one.
// Pairing other DEVICES is a different problem with a different answer (the
// device link); nothing here is reachable from off the machine.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

import type { BridgeFrame, BridgeScope, ClientFrame } from '../shared/bridgeProtocol'
import { BRIDGE_MARKER_META, BRIDGE_PATH, isBridgeScope } from '../shared/bridgeProtocol'
import { BrowserWindow, ipcMain } from './electronShim'

const LAUNCH_CODE_TTL_MS = 5 * 60_000
const SESSION_COOKIE = 'r3s'
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
/** Generous for a catalogue page, far below anything that could exhaust memory. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export interface BridgeOptions {
  /** The built renderer (npm run build:web). */
  siteDir: string
  /** 0 lets the OS choose. */
  port?: number
  /** The window each scope's pushes are sent to. */
  windows: Record<BridgeScope, BrowserWindow>
  /** Where signed-in browsers are remembered across a restart of this
   *  process. Omitted, they are forgotten with it. */
  sessionFile?: string
}

export interface Bridge {
  readonly origin: string
  /** Open this once: it signs the browser in and lands on the app. */
  readonly launchUrl: string
  close(): Promise<void>
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/**
 * The browsers that have signed in, remembered across a restart.
 *
 * A backend that restarts (an update, a crash, the host recycling it) must not
 * lock out the page that was talking to it: that page's whole recovery is
 * "reconnect, notice the backend is new, reload" — which only works if its
 * cookie still means something afterwards. So sessions are kept on disk, as
 * SHA-256 digests (the file is not a bearer token for whoever reads it) with
 * an expiry, owner-only.
 */
function sessionStore(file: string | undefined): {
  has(token: string): boolean
  add(token: string): void
} {
  const digest = (token: string): string => crypto.createHash('sha256').update(token).digest('hex')
  const live = new Map<string, number>()

  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>
      for (const [hash, expiresAt] of Object.entries(saved)) {
        if (typeof expiresAt === 'number' && expiresAt > Date.now()) live.set(hash, expiresAt)
      }
    } catch {
      // An unreadable file costs a sign-in, never the backend.
    }
  }

  const save = (): void => {
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 })
    } catch {
      // Same: not remembered is a nuisance, not a failure.
    }
  }

  return {
    has(token) {
      const expiresAt = live.get(digest(token))
      return expiresAt !== undefined && expiresAt > Date.now()
    },
    add(token) {
      for (const [hash, expiresAt] of live) if (expiresAt <= Date.now()) live.delete(hash)
      live.set(digest(token), Date.now() + SESSION_TTL_MS)
      save()
    }
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

/** What ipcRenderer.invoke rejects with, word for word — renderer code that
 *  reads an error message reads the same one on every platform. */
function invokeErrorMessage(channel: string, error: unknown): string {
  return `Error invoking remote method '${channel}': ${String(error)}`
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const siteDir = path.resolve(options.siteDir)
  const indexPath = path.join(siteDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    throw new Error(`${indexPath} is missing — build the renderer first (npm run build:web).`)
  }

  // Told to the page on every connection, so it can tell "the link dropped and
  // came back" from "the backend I was talking to is gone and this is a new
  // one" — after which nothing it holds (a playback session, a party) is true.
  const bootNonce = crypto.randomBytes(12).toString('hex')

  let launchCode: string | null = crypto.randomBytes(32).toString('hex')
  const launchExpiresAt = Date.now() + LAUNCH_CODE_TTL_MS
  const sessions = sessionStore(options.sessionFile)

  const connections: Record<BridgeScope, Set<WebSocket>> = { main: new Set(), overlay: new Set() }

  for (const scope of Object.keys(options.windows) as BridgeScope[]) {
    options.windows[scope].webContents.setPushSink((channel, payload) => {
      if (!connections[scope].size) return
      const frame: BridgeFrame = { t: 'event', channel, payload }
      const text = JSON.stringify(frame)
      for (const socket of connections[scope]) socket.send(text)
    })
  }

  let allowedHosts = new Set<string>()
  let origins = new Set<string>()

  const hasSession = (req: http.IncomingMessage): boolean => {
    const value = cookieValue(req.headers.cookie, SESSION_COOKIE)
    return value !== null && sessions.has(value)
  }

  const server = http.createServer((req, res) => {
    const deny = (status: number, message: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Method not allowed.')
    if (!allowedHosts.has(String(req.headers.host))) return deny(403, 'Unknown host.')

    const url = new URL(req.url ?? '/', 'http://bridge')

    // The one door that opens without a session: a live launch code.
    const offered = url.searchParams.get('launch')
    if (offered !== null) {
      const live = launchCode !== null && Date.now() < launchExpiresAt
      if (!live || !timingSafeEqualText(offered, launchCode as string)) {
        return deny(403, 'That launch link has already been used or has expired.')
      }
      launchCode = null
      const session = crypto.randomBytes(32).toString('hex')
      sessions.add(session)
      res
        .writeHead(303, {
          'set-cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
          location: '/',
          'cache-control': 'no-store'
        })
        .end()
      return
    }

    if (!hasSession(req))
      return deny(401, 'Not signed in. Open the launch link the backend printed.')

    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const filePath = path.join(siteDir, relative)
    if (!filePath.startsWith(siteDir + path.sep) || !fs.existsSync(filePath)) {
      return deny(404, 'Not found.')
    }
    if (!fs.statSync(filePath).isFile()) return deny(404, 'Not found.')

    const headers: Record<string, string> = {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      // Nothing the page loads from elsewhere (poster art) learns where it
      // was loaded from.
      'referrer-policy': 'no-referrer'
    }
    if (filePath === indexPath) {
      // The marker is how the page knows a bridge is on the other end of its
      // own origin — without it, the same files are the backend-less build.
      const html = fs
        .readFileSync(indexPath, 'utf8')
        .replace('<head>', `<head>\n    ${BRIDGE_MARKER_META}`)
      headers['cache-control'] = 'no-store'
      res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : html)
      return
    }
    // Hashed filenames: safe to keep.
    headers['cache-control'] = 'public, max-age=31536000, immutable'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(filePath).pipe(res)
  })

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    const url = new URL(req.url ?? '/', 'http://bridge')
    const scope = url.searchParams.get('scope')
    if (url.pathname !== BRIDGE_PATH || !isBridgeScope(scope)) return refuse('404 Not Found')
    if (!allowedHosts.has(String(req.headers.host))) return refuse('403 Forbidden')
    if (!origins.has(String(req.headers.origin))) return refuse('403 Forbidden')
    if (!hasSession(req)) return refuse('401 Unauthorized')

    sockets.handleUpgrade(req, socket, head, (ws) => attach(ws, scope))
  })

  function attach(ws: WebSocket, scope: BridgeScope): void {
    const window = options.windows[scope]
    // What a handler sees as "who is calling": this scope's window, from its
    // main frame. ipc/trustedSender.ts checks exactly these two things, and
    // they are true — this connection IS that window's renderer, admitted
    // above.
    const event = {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
      frameId: 1,
      processId: 1
    }

    const reply = (frame: BridgeFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    connections[scope].add(ws)
    reply({ t: 'welcome', bootNonce })

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text frames only')
      let frame: ClientFrame
      try {
        frame = JSON.parse(String(data)) as ClientFrame
      } catch {
        return ws.close(1007, 'malformed frame')
      }
      if (!frame || typeof frame.channel !== 'string' || !Array.isArray(frame.args)) {
        return ws.close(1007, 'malformed frame')
      }

      if (frame.t === 'send') {
        ipcMain.dispatchSend(event, frame.channel, frame.args)
        return
      }
      if (frame.t !== 'invoke' || typeof frame.id !== 'number') {
        return ws.close(1007, 'malformed frame')
      }
      const { id, channel } = frame
      ipcMain.dispatchInvoke(event, channel, frame.args).then(
        (value) => reply({ t: 'result', id, ok: true, value }),
        (error) => reply({ t: 'result', id, ok: false, error: invokeErrorMessage(channel, error) })
      )
    })

    ws.on('close', () => {
      connections[scope].delete(ws)
      // The desktop renderer's teardown runs when its window closes; here the
      // connection going away is the only signal there is.
      window.webContents.emit('bridge-disconnected')
    })
    ws.on('error', () => ws.terminate())
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })

  const { port } = server.address() as AddressInfo
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    launchUrl: `${origin}/?launch=${launchCode}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const scope of Object.keys(connections) as BridgeScope[]) {
          for (const socket of connections[scope]) socket.terminate()
        }
        sockets.close()
        server.close(() => resolve())
      })
  }
}
