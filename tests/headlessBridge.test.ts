// The bridge between a renderer outside Electron and the headless backend
// (src/headless/bridge.ts), driven over real sockets. Two halves: who is let
// in, and whether what crosses is what ipcRenderer would have carried.
// Run with: npx tsx tests/headlessBridge.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-bridge-'))
process.env.R3_USER_DATA = scratch

import { startBridge, type Bridge } from '../src/headless/bridge'
import { BrowserWindow, ipcMain } from '../src/headless/electronShim'
import { wireArgs, type BridgeFrame } from '../src/shared/bridgeProtocol'

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

// A stand-in for the built renderer: the bridge only needs files to serve.
const siteDir = path.join(scratch, 'site')
fs.mkdirSync(path.join(siteDir, 'assets'), { recursive: true })
fs.writeFileSync(
  path.join(siteDir, 'index.html'),
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body></body></html>`
)
fs.writeFileSync(path.join(siteDir, 'assets', 'app.js'), 'console.log(1)')
fs.writeFileSync(path.join(scratch, 'secret.txt'), 'outside the site root')

const sessionFile = path.join(scratch, 'bridge-sessions.json')
const mainWindow = new BrowserWindow()
const overlayWindow = new BrowserWindow()
const windows = { main: mainWindow, overlay: overlayWindow }

const get = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { redirect: 'manual', headers })

/** Signs in with the bridge's launch link; returns the cookie to present. */
async function signIn(bridge: Bridge): Promise<string> {
  const response = await get(bridge.launchUrl)
  assert.equal(response.status, 303)
  return String(response.headers.get('set-cookie')).split(';')[0]
}

interface Inbox {
  /** Waits for, and removes, the first frame matching. */
  next(match: (f: BridgeFrame) => boolean): Promise<BridgeFrame>
}

type Attempt =
  | { socket: WebSocket; frames: Inbox; refused?: undefined }
  | { refused: number; socket?: undefined; frames?: undefined }

function connect(bridge: Bridge, scope: string, headers: Record<string, string>): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${bridge.origin.replace('http', 'ws')}/bridge?scope=${scope}`, {
      headers
    })
    // Listening from the moment the socket exists: the bridge greets a page
    // the instant it connects, and a listener attached after 'open' can
    // already be too late for that frame.
    const frames = inbox(socket)
    socket.once('open', () => resolve({ socket, frames }))
    socket.once('unexpected-response', (_req, res) => resolve({ refused: res.statusCode ?? 0 }))
    socket.once('error', (error) => {
      // 'unexpected-response' already answered for a refusal; anything else
      // is a real failure of the test itself.
      if (!/Unexpected server response/.test(error.message)) reject(error)
    })
  })
}

function inbox(socket: WebSocket): Inbox {
  const frames: BridgeFrame[] = []
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as BridgeFrame))
  return {
    next(match) {
      return new Promise((resolve, reject) => {
        const started = Date.now()
        const poll = (): void => {
          const at = frames.findIndex(match)
          if (at >= 0) return resolve(frames.splice(at, 1)[0])
          if (Date.now() - started > 3000) return reject(new Error('no matching frame in 3s'))
          setTimeout(poll, 10)
        }
        poll()
      })
    }
  }
}

async function main(): Promise<void> {
  ipcMain.handle('test:sum', (_event, payload) => {
    const { a, b } = payload as { a: number; b: number }
    return { sum: a + b }
  })
  ipcMain.handle('test:arity', (_event, ...args) => ({ count: args.length }))
  ipcMain.handle('test:fail', () => {
    throw new Error('Request failed (404)')
  })
  let whoCalled: unknown = null
  ipcMain.handle('test:who', (event) => {
    whoCalled = event
    return 'ok'
  })

  let bridge = await startBridge({ siteDir, windows, sessionFile })
  let cookie = ''

  // ---- who is let in ------------------------------------------------------

  await check('it listens on loopback and nowhere else', () => {
    assert.match(bridge.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  })

  await check('nothing is served to a browser that has not signed in', async () => {
    assert.equal((await get(`${bridge.origin}/`)).status, 401)
    assert.equal((await get(`${bridge.origin}/assets/app.js`)).status, 401)
  })

  await check('a wrong launch code is refused', async () => {
    assert.equal((await get(`${bridge.origin}/?launch=${'0'.repeat(64)}`)).status, 403)
  })

  await check(
    'the launch link signs in with a cookie script cannot read, and lands on a clean URL',
    async () => {
      const response = await get(bridge.launchUrl)
      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), '/', 'the code must not survive in the URL')
      const setCookie = String(response.headers.get('set-cookie'))
      assert.match(setCookie, /HttpOnly/i)
      assert.match(setCookie, /SameSite=Strict/i)
      cookie = setCookie.split(';')[0]
    }
  )

  await check('the launch link works once', async () => {
    assert.equal((await get(bridge.launchUrl)).status, 403)
  })

  await check('signed in, it serves the page — marked as bridged, CSP untouched', async () => {
    const response = await get(`${bridge.origin}/`, { cookie })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    const html = await response.text()
    assert.match(html, /<meta name="r3-bridge" content="ws" \/>/)
    assert.match(html, /script-src 'self'/)
  })

  await check('it will not serve a file from outside the site', async () => {
    for (const attempt of ['/../secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const response = await get(`${bridge.origin}${attempt}`, { cookie })
      assert.equal(response.status, 404, attempt)
    }
  })

  await check('it only answers to its own name (a rebound DNS name is refused)', async () => {
    const port = new URL(bridge.origin).port
    const response = await new Promise<number>((resolve, reject) => {
      // fetch() will not let Host be overridden; a raw request will.
      import('node:http').then(({ request }) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example', cookie } },
          (res) => resolve(res.statusCode ?? 0)
        )
        req.on('error', reject)
        req.end()
      })
    })
    assert.equal(response, 403)
  })

  await check('a socket with no session, or from another origin, is refused', async () => {
    assert.equal((await connect(bridge, 'main', { origin: bridge.origin })).refused, 401)
    assert.equal(
      (await connect(bridge, 'main', { cookie, origin: 'https://evil.example' })).refused,
      403
    )
    assert.equal((await connect(bridge, 'main', { cookie })).refused, 403, 'no Origin at all')
    assert.equal((await connect(bridge, 'kitchen', { cookie, origin: bridge.origin })).refused, 404)
  })

  // ---- what crosses -------------------------------------------------------

  const { socket, frames } = await connect(bridge, 'main', { cookie, origin: bridge.origin })
  assert.ok(socket && frames, 'the signed-in, same-origin socket should open')
  const say = (frame: unknown): void => socket.send(JSON.stringify(frame))
  let firstNonce = ''

  await check('it names this run of the backend the moment a page connects', async () => {
    const welcome = await frames.next((f) => f.t === 'welcome')
    assert.ok(welcome.t === 'welcome' && welcome.bootNonce.length >= 16)
    firstNonce = welcome.bootNonce
  })

  await check('an invoke reaches the registered handler and its answer comes back', async () => {
    say({ t: 'invoke', id: 1, channel: 'test:sum', args: [{ a: 2, b: 3 }] })
    assert.deepEqual(await frames.next((f) => f.t === 'result' && f.id === 1), {
      t: 'result',
      id: 1,
      ok: true,
      value: { sum: 5 }
    })
  })

  await check('"no payload" arrives as no argument, not as null', async () => {
    assert.deepEqual(wireArgs([undefined]), [])
    assert.deepEqual(wireArgs([{ a: 1 }, undefined]), [{ a: 1 }])
    say({ t: 'invoke', id: 2, channel: 'test:arity', args: wireArgs([undefined]) })
    const result = await frames.next((f) => f.t === 'result' && f.id === 2)
    assert.deepEqual(result.t === 'result' && result.ok && result.value, { count: 0 })
  })

  await check('a failure reads exactly as ipcRenderer.invoke would have put it', async () => {
    say({ t: 'invoke', id: 3, channel: 'test:fail', args: [] })
    assert.deepEqual(await frames.next((f) => f.t === 'result' && f.id === 3), {
      t: 'result',
      id: 3,
      ok: false,
      error: "Error invoking remote method 'test:fail': Error: Request failed (404)"
    })
  })

  await check('the handler sees this window as the sender, from its main frame', async () => {
    say({ t: 'invoke', id: 4, channel: 'test:who', args: [] })
    await frames.next((f) => f.t === 'result' && f.id === 4)
    const event = whoCalled as { sender: unknown; senderFrame: unknown }
    assert.equal(event.sender, mainWindow.webContents)
    assert.equal(event.senderFrame, mainWindow.webContents.mainFrame)
  })

  await check('a push reaches the window it was sent to, and only that one', async () => {
    const overlay = await connect(bridge, 'overlay', { cookie, origin: bridge.origin })
    assert.ok(overlay.socket && overlay.frames)
    const overlayFrames = overlay.frames
    await overlayFrames.next((f) => f.t === 'welcome')

    mainWindow.webContents.send('library:changed', { scopes: ['history'] })
    overlayWindow.webContents.send('player:state', { paused: true })

    assert.deepEqual(await frames.next((f) => f.t === 'event'), {
      t: 'event',
      channel: 'library:changed',
      payload: { scopes: ['history'] }
    })
    assert.deepEqual(await overlayFrames.next((f) => f.t === 'event'), {
      t: 'event',
      channel: 'player:state',
      payload: { paused: true }
    })
    // Neither got the other's.
    await assert.rejects(
      overlayFrames.next((f) => f.t === 'event'),
      /no matching frame/
    )
    overlay.socket.close()
  })

  await check('a frame that is not one of ours ends the connection', async () => {
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
    socket.send('{"t":"invoke","id":"not-a-number","channel":"test:sum","args":[]}')
    assert.equal(await closed, 1007)
  })

  // ---- across a restart ---------------------------------------------------

  await check('a restarted backend still knows the browser, and says it is a new run', async () => {
    await bridge.close()
    const port = Number(new URL(bridge.origin).port)
    bridge = await startBridge({ siteDir, windows, sessionFile, port })

    assert.equal(
      (await get(`${bridge.origin}/`, { cookie })).status,
      200,
      'the old cookie still signs in'
    )
    const again = await connect(bridge, 'main', { cookie, origin: bridge.origin })
    assert.ok(again.socket && again.frames)
    const welcome = await again.frames.next((f) => f.t === 'welcome')
    assert.ok(welcome.t === 'welcome' && welcome.bootNonce !== firstNonce)
    again.socket.close()
  })

  await check('what is remembered is not the cookie itself', () => {
    const saved = fs.readFileSync(sessionFile, 'utf8')
    assert.equal(
      saved.includes(cookie.split('=')[1]),
      false,
      'the session token is on disk in the clear'
    )
  })

  await check('without a session file, a restart forgets', async () => {
    const forgetful = await startBridge({ siteDir, windows })
    const fresh = await signIn(forgetful)
    const port = Number(new URL(forgetful.origin).port)
    await forgetful.close()
    const reborn = await startBridge({ siteDir, windows, port })
    assert.equal((await get(`${reborn.origin}/`, { cookie: fresh })).status, 401)
    await reborn.close()
  })

  await bridge.close()
  console.log(`\n${pass} passed`)
}

void main()
