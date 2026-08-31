// Phase-0 spike for embedding mpv INSIDE the main window. Runs INSTEAD of the
// app when R3_EMBED_SPIKE=1, and is throwaway by design (deleted once the
// embed ships).
//
// What it has to prove: mpv attached to a BrowserWindow with --wid renders
// BEHIND Chromium's compositor child ("Intermediate D3D Window") — that is the
// measured failure that un-embedded mpv in commit 0ae7dfb. The bet under test
// is that raising mpv's child ABOVE that sibling makes its pixels visible, the
// way windowed browser plugins always composited over page content.
//
// Every verdict comes from an OS-level screenshot (desktopCapturer — a real
// screen capture that includes foreign child HWNDs, which webContents
// .capturePage does not), never from mpv property reads. Reading `current-vo`
// and calling it "verified" is the exact mistake 0ae7dfb documents.
//
// Method: a loud magenta page; mpv playing a solid GREEN lavfi source,
// stretched (--keepaspect=no) so every sampled point inside the content area
// is unambiguously video or unambiguously page.

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { BrowserWindow, app, desktopCapturer, screen } from 'electron'

import {
  addWindowStyle,
  clickAtScreenPoint,
  findChildByPid,
  getClientSize,
  hwndOf,
  listChildTree,
  raiseToTopOfSiblings,
  removeWindowStyle,
  setChildRect,
  WS_CLIPSIBLINGS,
  WS_DISABLED,
  win32Available
} from './win32'

const OUT_DIR = path.join(process.cwd(), '.ai', 'spike')

const log = (msg: string): void => console.log(`[spike] ${msg}`)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --------------------------------------------------------------------------
// Minimal mpv JSON-IPC client — deliberately not MpvPlayer, so the spike
// touches no production file beyond its one index.ts call site.
// --------------------------------------------------------------------------

class SpikeMpv {
  child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private readonly eventListeners: Array<(msg: Record<string, unknown>) => void> = []

  get pid(): number {
    return this.child?.pid ?? 0
  }

  async start(mpvPath: string, wid: bigint): Promise<void> {
    const pipeName = `r3-embed-spike-${crypto.randomBytes(8).toString('hex')}`
    const args = [
      `--input-ipc-server=\\\\.\\pipe\\${pipeName}`,
      '--no-config',
      '--load-scripts=no',
      '--ytdl=no',
      '--idle=yes',
      '--force-window=no',
      '--keep-open=yes',
      '--no-input-default-bindings',
      '--input-vo-keyboard=yes',
      '--osc=no',
      '--osd-level=0',
      '--hwdec=auto-safe',
      // Stretch to fill so sampled points are video, not letterbox bars.
      '--keepaspect=no',
      // Production parity: without this, mpv treats a left-press on the
      // picture as a window-drag gesture and swallows the click binding.
      '--window-dragging=no',
      '--focus-on=never',
      '--msg-level=all=warn',
      `--wid=${wid.toString()}`
    ]
    log(`spawning mpv: ${mpvPath} --wid=${wid}`)
    const child = spawn(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => log(`mpv! ${chunk.toString().trim()}`))
    child.once('exit', (code) => log(`mpv exited (${code})`))

    const pipePath = `\\\\.\\pipe\\${pipeName}`
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect({ path: pipePath })
          socket.once('connect', () => {
            this.socket = socket
            socket.on('data', (data) => this.onData(data))
            resolve()
          })
          socket.once('error', reject)
        })
        return
      } catch {
        await sleep(100)
      }
    }
    throw new Error('spike: could not connect to mpv IPC pipe')
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString()
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.request_id === 'number' && this.pending.has(msg.request_id)) {
        const resolve = this.pending.get(msg.request_id)!
        this.pending.delete(msg.request_id)
        resolve(msg)
      } else if (typeof msg.event === 'string') {
        for (const listener of this.eventListeners) listener(msg)
      }
    }
  }

  onEvent(listener: (msg: Record<string, unknown>) => void): void {
    this.eventListeners.push(listener)
  }

  command(cmd: unknown[]): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('spike: mpv socket not connected'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`spike: mpv command timed out: ${JSON.stringify(cmd)}`))
      }, 15000)
      this.pending.set(requestId, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      socket.write(`${JSON.stringify({ command: cmd, request_id: requestId })}\n`)
    })
  }

  /** Resolves when observed property `name` reports a value `predicate` accepts. */
  waitForProperty(
    name: string,
    predicate: (value: unknown) => boolean,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`spike: timed out waiting for ${name}`)),
        timeoutMs
      )
      this.onEvent((msg) => {
        if (msg.event === 'property-change' && msg.name === name && predicate(msg.data)) {
          clearTimeout(timer)
          resolve()
        }
      })
      void this.command(['observe_property', this.nextId + 1000, name])
    })
  }

  kill(): void {
    this.socket?.destroy()
    this.child?.kill()
  }
}

// --------------------------------------------------------------------------
// Screenshot + pixel sampling
// --------------------------------------------------------------------------

interface Sample {
  x: number
  y: number
  r: number
  g: number
  b: number
}

const isMagenta = (s: Sample): boolean => s.r > 180 && s.b > 180 && s.g < 90
const isGreen = (s: Sample): boolean => s.g > 180 && s.r < 90 && s.b < 90

/** Content area of `win` in physical screen pixels. */
function contentRectPhysical(win: BrowserWindow): Electron.Rectangle {
  return screen.dipToScreenRect(win, win.getContentBounds())
}

/**
 * Captures the display the window sits on and samples a 3x3 grid inside the
 * window's content area. Saves the full capture to OUT_DIR as `${name}.png`.
 */
async function captureAndSample(win: BrowserWindow, name: string): Promise<Sample[]> {
  const display = screen.getDisplayMatching(win.getBounds())
  const physW = Math.round(display.size.width * display.scaleFactor)
  const physH = Math.round(display.size.height * display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physW, height: physH }
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) throw new Error('spike: no screen capture source available')
  const image = source.thumbnail
  const { width: imgW, height: imgH } = image.getSize()
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), image.toPNG())

  // Window content rect in physical screen coords -> capture coords. The
  // display's physical origin: its DIP origin scaled by its own factor (exact
  // for the primary display, which is where the spike window is placed).
  const rect = contentRectPhysical(win)
  const originX = display.bounds.x * display.scaleFactor
  const originY = display.bounds.y * display.scaleFactor
  const scaleX = imgW / physW
  const scaleY = imgH / physH
  const bitmap = image.toBitmap() // BGRA
  const samples: Sample[] = []
  for (const fy of [0.15, 0.5, 0.85]) {
    for (const fx of [0.15, 0.5, 0.85]) {
      const px = Math.round((rect.x - originX + rect.width * fx) * scaleX)
      const py = Math.round((rect.y - originY + rect.height * fy) * scaleY)
      const offset = (py * imgW + px) * 4
      samples.push({
        x: px,
        y: py,
        b: bitmap[offset],
        g: bitmap[offset + 1],
        r: bitmap[offset + 2]
      })
    }
  }
  log(
    `${name}: ${samples
      .map((s) => `(${s.x},${s.y})#${[s.r, s.g, s.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
      .join(' ')}`
  )
  return samples
}

// --------------------------------------------------------------------------
// The spike itself
// --------------------------------------------------------------------------

function findSpikeMpv(): string {
  const candidates = [
    process.env.MPV_PATH,
    path.join(process.cwd(), 'resources', 'mpv-win', 'mpv.exe')
  ].filter((p): p is string => Boolean(p))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('spike: mpv.exe not found (set MPV_PATH or run scripts/fetch-mpv.ts)')
}

function logTree(parent: bigint, label: string): void {
  const tree = listChildTree(parent)
  log(`child tree ${label}:`)
  for (const node of tree) {
    log(
      `  ${'  '.repeat(node.depth - 1)}0x${node.hwnd.toString(16)} "${node.className}" pid=${node.pid} style=0x${node.style.toString(16)} ex=0x${node.exStyle.toString(16)}`
    )
  }
}

export async function runEmbedSpike(): Promise<void> {
  const results: Record<string, boolean> = {}
  const verdict = (step: string, pass: boolean): void => {
    results[step] = pass
    log(`${pass ? 'PASS' : 'FAIL'} ${step}`)
  }

  let mpv: SpikeMpv | null = null
  try {
    if (!win32Available()) throw new Error('spike: not on Windows')
    fs.mkdirSync(OUT_DIR, { recursive: true })

    // A plain window with a loud magenta page, parked on the primary display
    // (the capture->pixel coordinate mapping assumes it).
    const primary = screen.getPrimaryDisplay()
    const win = new BrowserWindow({
      x: primary.bounds.x + 60,
      y: primary.bounds.y + 60,
      width: 1280,
      height: 720,
      backgroundColor: '#ff00ff',
      webPreferences: { sandbox: true }
    })
    await win.loadURL(
      'data:text/html,<title>embed spike</title><body style="background:%23ff00ff"></body>'
    )
    win.show()
    await sleep(800)

    const parentHwnd = hwndOf(win)
    log(`main window hwnd=0x${parentHwnd.toString(16)}`)
    logTree(parentHwnd, 'before mpv')

    // Sanity-check the capture pipeline itself before judging mpv with it.
    const baseline = await captureAndSample(win, 'a-baseline')
    verdict('baseline-magenta', baseline.every(isMagenta))

    // mpv, embedded with --wid, playing solid green.
    mpv = new SpikeMpv()
    await mpv.start(findSpikeMpv(), parentHwnd)
    const clickMessages: string[] = []
    mpv.onEvent((msg) => {
      if (msg.event === 'client-message') {
        const args = Array.isArray(msg.args) ? msg.args.join(' ') : ''
        clickMessages.push(args)
        log(`client-message: ${args}`)
      }
    })
    await mpv.command(['keybind', 'MBTN_LEFT', 'script-message r3-spike-click'])
    const voConfigured = mpv.waitForProperty('vo-configured', (v) => v === true, 20000)
    const spikeFile = process.env.R3_EMBED_SPIKE_FILE || 'av://lavfi:color=c=0x00FF00:s=640x360'
    await mpv.command(['loadfile', spikeFile])
    await voConfigured
    await sleep(600)

    logTree(parentHwnd, 'after vo-configured')
    const mpvChild = findChildByPid(parentHwnd, mpv.pid)
    if (!mpvChild) throw new Error('spike: no mpv child window found under the main window')
    log(`mpv child hwnd=0x${mpvChild.toString(16)}`)

    // Screenshot A: the 0ae7dfb state (expected: still magenta — mpv behind).
    const before = await captureAndSample(win, 'b-before-raise')
    log(`before raise: ${before.filter(isGreen).length}/9 green`)

    // THE BET: raise mpv's child above Chromium's compositor sibling. mpv
    // creates its --wid child WS_DISABLED (embed etiquette: input falls
    // through to the host) — strip that so clicks land on mpv and its safety
    // bindings keep working, matching the floating-window input model.
    addWindowStyle(mpvChild, WS_CLIPSIBLINGS)
    removeWindowStyle(mpvChild, WS_DISABLED)
    const raised = raiseToTopOfSiblings(mpvChild)
    log(`raiseToTopOfSiblings -> ${raised}`)
    const size = getClientSize(parentHwnd)
    if (size) setChildRect(mpvChild, 0, 0, size.width, size.height)
    await sleep(400)
    logTree(parentHwnd, 'after raise')

    // Screenshot B — THE GATE.
    const after = await captureAndSample(win, 'c-after-raise')
    verdict(
      'gate-video-visible',
      after.filter((s) => !isMagenta(s)).length >= 7 && isGreen(after[4])
    )

    // Resize tracking: shrink the window, refill the client rect.
    win.setContentSize(960, 540)
    await sleep(300)
    const resized = getClientSize(parentHwnd)
    if (resized) setChildRect(mpvChild, 0, 0, resized.width, resized.height)
    await sleep(400)
    const afterResize = await captureAndSample(win, 'd-after-resize')
    verdict('resize-tracks', isGreen(afterResize[4]) && !isMagenta(afterResize[0]))

    // Input: a synthetic click on the picture must come back as the bound
    // script-message (the safety-key path every control fallback rides).
    // Focus the window first — a click into an inactive window can be eaten
    // by activation — and probe mpv's own mouse-pos to see whether mouse
    // events reach its wndproc at all.
    win.focus()
    await sleep(300)
    const rect = contentRectPhysical(win)
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    clickAtScreenPoint(cx, cy)
    await sleep(250)
    clickAtScreenPoint(cx, cy)
    await sleep(500)
    try {
      const mousePos = await mpv.command(['get_property', 'mouse-pos'])
      log(`mpv mouse-pos: ${JSON.stringify(mousePos.data)}`)
    } catch (error) {
      log(`mouse-pos query failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    verdict('click-reaches-mpv', clickMessages.some((m) => m.includes('r3-spike-click')))

    // Stop must reveal the page again (--force-window=no destroys the child).
    await mpv.command(['stop'])
    await sleep(600)
    const childAfterStop = findChildByPid(parentHwnd, mpv.pid)
    log(`child after stop: ${childAfterStop ? `still 0x${childAfterStop.toString(16)}` : 'gone'}`)
    const afterStop = await captureAndSample(win, 'e-after-stop')
    verdict('stop-reveals-page', afterStop.every(isMagenta))
    results['stop-destroys-child'] = childAfterStop === null

    // Fullscreen via ELECTRON (mpv's own fullscreen is out of the design):
    // reload, fullscreen the window, refill the client rect.
    const voAgain = mpv.waitForProperty('vo-configured', (v) => v === true, 20000)
    await mpv.command(['loadfile', spikeFile])
    await voAgain
    await sleep(400)
    const mpvChild2 = findChildByPid(parentHwnd, mpv.pid)
    if (mpvChild2) {
      addWindowStyle(mpvChild2, WS_CLIPSIBLINGS)
      removeWindowStyle(mpvChild2, WS_DISABLED)
      raiseToTopOfSiblings(mpvChild2)
    }
    win.setFullScreen(true)
    await sleep(900)
    const fsSize = getClientSize(parentHwnd)
    if (mpvChild2 && fsSize) setChildRect(mpvChild2, 0, 0, fsSize.width, fsSize.height)
    await sleep(400)
    const fsSamples = await captureAndSample(win, 'f-fullscreen')
    verdict('fullscreen-fills', isGreen(fsSamples[4]) && isGreen(fsSamples[0]))
    win.setFullScreen(false)
    await sleep(500)
  } catch (error) {
    log(`ERROR ${error instanceof Error ? error.message : String(error)}`)
    results['no-crash'] = false
  } finally {
    mpv?.kill()
  }

  const gate = ['baseline-magenta', 'gate-video-visible', 'resize-tracks', 'stop-reveals-page']
  const go = gate.every((step) => results[step] === true)
  fs.writeFileSync(
    path.join(OUT_DIR, 'spike-report.json'),
    JSON.stringify({ when: new Date().toISOString(), results, go }, null, 2)
  )
  log(`RESULTS ${JSON.stringify(results)}`)
  log(go ? 'VERDICT: GO' : 'VERDICT: NO-GO')
  app.exit(go ? 0 : 1)
}
