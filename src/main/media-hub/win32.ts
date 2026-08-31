// Thin FFI layer over user32.dll (koffi), for the mpv embed work: finding and
// reordering the child windows inside the main BrowserWindow's HWND, which
// Electron's own API cannot reach. Main process only, and Windows only — every
// export no-ops (or returns null) on other platforms, so callers can import
// unconditionally.
//
// HWNDs travel as bigint: the full pointer read out of
// BrowserWindow.getNativeWindowHandle(), unsigned (mpv's --wid is documented to
// assume a positive window id — mpv#10189), declared int64_t on the FFI
// boundary. koffi ships prebuilt N-API binaries, so this stays compatible with
// the repo's no-native-toolchain posture (npmRebuild: false).

import type { BrowserWindow } from 'electron'
import koffi from 'koffi'

export const GW_HWNDNEXT = 2
export const GW_CHILD = 5

export const SW_HIDE = 0
export const SW_SHOWNA = 8

export const GWL_STYLE = -16
export const GWL_EXSTYLE = -20
export const GWLP_HWNDPARENT = -8

export const WS_VISIBLE = 0x10000000n
export const WS_DISABLED = 0x08000000n
export const WS_CHILD = 0x40000000n
export const WS_CLIPSIBLINGS = 0x04000000n
export const WS_CLIPCHILDREN = 0x02000000n
export const WS_EX_TOOLWINDOW = 0x00000080n

export const HWND_TOP = 0n

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010

// koffi returns int64_t as a plain number when the value fits in a double, and
// as bigint otherwise — normalize every 64-bit return through this.
const big = (value: number | bigint): bigint => (typeof value === 'bigint' ? value : BigInt(value))

interface User32 {
  FindWindowExW: (
    parent: bigint,
    after: bigint,
    cls: string | null,
    title: string | null
  ) => number | bigint
  GetWindow: (hwnd: bigint, cmd: number) => number | bigint
  GetClassNameW: (hwnd: bigint, buf: Uint16Array, max: number) => number
  GetClientRect: (hwnd: bigint, rect: Record<string, number>) => boolean
  GetWindowRect: (hwnd: bigint, rect: Record<string, number>) => boolean
  SetWindowPos: (
    hwnd: bigint,
    insertAfter: bigint,
    x: number,
    y: number,
    w: number,
    h: number,
    flags: number
  ) => boolean
  ShowWindow: (hwnd: bigint, cmd: number) => boolean
  IsWindow: (hwnd: bigint) => boolean
  GetWindowLongPtrW: (hwnd: bigint, index: number) => number | bigint
  SetWindowLongPtrW: (hwnd: bigint, index: number, value: bigint) => number | bigint
  SetParent: (hwnd: bigint, parent: bigint) => number | bigint
  GetWindowThreadProcessId: (hwnd: bigint, pid: Uint32Array) => number
  SetCursorPos: (x: number, y: number) => boolean
  mouse_event: (flags: number, dx: number, dy: number, data: number, extra: bigint) => void
}

let user32: User32 | null | undefined

/** Loads user32 on first use; null anywhere but Windows. */
function api(): User32 | null {
  if (user32 !== undefined) return user32
  if (process.platform !== 'win32') {
    user32 = null
    return user32
  }
  const lib = koffi.load('user32.dll')
  koffi.struct('R3Rect', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  user32 = {
    FindWindowExW: lib.func('int64_t FindWindowExW(int64_t, int64_t, str16, str16)'),
    GetWindow: lib.func('int64_t GetWindow(int64_t, uint32_t)'),
    GetClassNameW: lib.func('int GetClassNameW(int64_t, _Out_ uint16_t *, int)'),
    GetClientRect: lib.func('bool GetClientRect(int64_t, _Out_ R3Rect *)'),
    GetWindowRect: lib.func('bool GetWindowRect(int64_t, _Out_ R3Rect *)'),
    SetWindowPos: lib.func('bool SetWindowPos(int64_t, int64_t, int, int, int, int, uint32_t)'),
    ShowWindow: lib.func('bool ShowWindow(int64_t, int)'),
    IsWindow: lib.func('bool IsWindow(int64_t)'),
    GetWindowLongPtrW: lib.func('int64_t GetWindowLongPtrW(int64_t, int)'),
    SetWindowLongPtrW: lib.func('int64_t SetWindowLongPtrW(int64_t, int, int64_t)'),
    SetParent: lib.func('int64_t SetParent(int64_t, int64_t)'),
    GetWindowThreadProcessId: lib.func('uint32_t GetWindowThreadProcessId(int64_t, _Out_ uint32_t *)'),
    SetCursorPos: lib.func('bool SetCursorPos(int, int)'),
    mouse_event: lib.func('void mouse_event(uint32_t, uint32_t, uint32_t, uint32_t, uint64_t)')
  }
  return user32
}

export function win32Available(): boolean {
  return api() !== null
}

/** The top-level HWND behind a BrowserWindow, as the unsigned pointer value. */
export function hwndOf(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigUInt64LE(0)
}

export function isWindowAlive(hwnd: bigint): boolean {
  const u = api()
  return u ? u.IsWindow(hwnd) : false
}

export function classNameOf(hwnd: bigint): string {
  const u = api()
  if (!u) return ''
  const buf = new Uint16Array(256)
  const len = u.GetClassNameW(hwnd, buf, buf.length)
  return len > 0 ? Buffer.from(buf.buffer, 0, len * 2).toString('utf16le') : ''
}

export function windowPidOf(hwnd: bigint): number {
  const u = api()
  if (!u) return 0
  const pid = new Uint32Array(1)
  u.GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

export function windowStyleOf(hwnd: bigint): { style: bigint; exStyle: bigint } {
  const u = api()
  if (!u) return { style: 0n, exStyle: 0n }
  return {
    // GetWindowLongPtr returns a sign-extended value; styles are 32-bit masks,
    // so mask back to unsigned for readable logging and testable flags.
    style: BigInt.asUintN(32, big(u.GetWindowLongPtrW(hwnd, GWL_STYLE))),
    exStyle: BigInt.asUintN(32, big(u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)))
  }
}

export function addWindowStyle(hwnd: bigint, flags: bigint): void {
  const u = api()
  if (!u) return
  const current = BigInt.asUintN(32, big(u.GetWindowLongPtrW(hwnd, GWL_STYLE)))
  if ((current & flags) === flags) return
  u.SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt.asIntN(64, current | flags))
}

export function removeWindowStyle(hwnd: bigint, flags: bigint): void {
  const u = api()
  if (!u) return
  const current = BigInt.asUintN(32, big(u.GetWindowLongPtrW(hwnd, GWL_STYLE)))
  if ((current & flags) === 0n) return
  u.SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt.asIntN(64, current & ~flags))
}

export interface ChildWindowInfo {
  hwnd: bigint
  depth: number
  className: string
  pid: number
  style: bigint
  exStyle: bigint
}

/** Depth-first walk of a window's child tree in sibling z-order (top first),
 *  via GetWindow rather than EnumChildWindows — no FFI callbacks needed. */
export function listChildTree(parent: bigint, maxDepth = 3): ChildWindowInfo[] {
  const u = api()
  if (!u) return []
  const out: ChildWindowInfo[] = []
  const walk = (hwnd: bigint, depth: number): void => {
    if (depth > maxDepth) return
    let child = big(u.GetWindow(hwnd, GW_CHILD))
    let guard = 0
    while (child !== 0n && guard++ < 256) {
      const { style, exStyle } = windowStyleOf(child)
      out.push({
        hwnd: child,
        depth,
        className: classNameOf(child),
        pid: windowPidOf(child),
        style,
        exStyle
      })
      walk(child, depth + 1)
      child = big(u.GetWindow(child, GW_HWNDNEXT))
    }
  }
  walk(parent, 1)
  return out
}

/** First direct child of `parent` belonging to process `pid`, or null. */
export function findChildByPid(parent: bigint, pid: number): bigint | null {
  const u = api()
  if (!u) return null
  let child = big(u.GetWindow(parent, GW_CHILD))
  let guard = 0
  while (child !== 0n && guard++ < 256) {
    if (windowPidOf(child) === pid) return child
    child = big(u.GetWindow(child, GW_HWNDNEXT))
  }
  return null
}

export function getClientSize(hwnd: bigint): { width: number; height: number } | null {
  const u = api()
  if (!u) return null
  const rect: Record<string, number> = {}
  if (!u.GetClientRect(hwnd, rect)) return null
  return { width: rect.right - rect.left, height: rect.bottom - rect.top }
}

/** Moves/sizes a child window within its parent's client area (physical px),
 *  leaving z-order alone. */
export function setChildRect(hwnd: bigint, x: number, y: number, w: number, h: number): void {
  api()?.SetWindowPos(hwnd, 0n, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)
}

/** Raises a window to the top of its sibling z-order without moving, sizing,
 *  or activating it. Returns false if the call was refused. */
export function raiseToTopOfSiblings(hwnd: bigint): boolean {
  const u = api()
  if (!u) return false
  return u.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
}

export function setShown(hwnd: bigint, shown: boolean): void {
  api()?.ShowWindow(hwnd, shown ? SW_SHOWNA : SW_HIDE)
}

/** Synthesizes one left click at a physical screen point (spike only: proves
 *  input reaches an embedded child with nobody at the keyboard). */
export function clickAtScreenPoint(x: number, y: number): void {
  const u = api()
  if (!u) return
  const MOUSEEVENTF_LEFTDOWN = 0x0002
  const MOUSEEVENTF_LEFTUP = 0x0004
  u.SetCursorPos(Math.round(x), Math.round(y))
  u.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n)
  u.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n)
}
