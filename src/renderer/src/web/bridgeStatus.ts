// Says so when the backend cannot be reached.
//
// The app is written to survive having no backend: nearly every call site is
// `window.api?.…` and falls back to an honest empty state. That is exactly
// right for a build that never had one — and exactly wrong for a link that
// DROPPED, where the same grace paints a calm, plausible, empty app and gives
// nobody any reason to think anything is the matter. So the one thing that
// knows the difference says it, outside React and above everything, where no
// screen's own state can hide it.
//
// Plain DOM on purpose: it must work while the app is mid-render, mid-crash or
// not yet mounted, and it must not pull the app's state into knowing about
// transports.

import type { WebTransport } from './transport'

/** A blip shorter than this is a blip; saying anything would be noise. */
const SPEAK_AFTER_MS = 1500

export function showBridgeStatus(transport: WebTransport): void {
  let banner: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const show = (): void => {
    if (banner) return
    banner = document.createElement('div')
    banner.setAttribute('role', 'status')
    banner.textContent = 'Reconnecting to the app’s backend…'
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      padding: '10px 16px',
      font: '600 14px/1.3 system-ui, sans-serif',
      textAlign: 'center',
      color: '#fff',
      background: '#8a1c1c',
      pointerEvents: 'none'
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.appendChild(banner)
  }

  const hide = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    banner?.remove()
    banner = null
  }

  transport.onStateChange((state) => {
    if (state === 'open') return hide()
    if (state === 'reconnecting' && !timer && !banner) timer = setTimeout(show, SPEAK_AFTER_MS)
  })
}
