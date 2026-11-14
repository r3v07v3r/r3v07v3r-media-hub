// The renderer's half of automatic tester reports: errors this window
// threw, the same control pressed again and again, and back-and-forth
// between two screens. Each goes to the main process, which drops it when
// diagnostics are off and sanitises it otherwise (main/media-hub/feedback/).
//
// What is NEVER read: anything typed into a field. A click is described by
// the control's own label, and only for buttons, links, switches, tabs and
// menu items.

import { PingPongDetector, RepeatDetector } from '@shared/feedback/repeatDetector'
import type { RendererProblem } from '@shared/feedback/types'

const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]'
].join(',')

/** Controls made to be pressed repeatedly: stepping through a rail, a
 *  volume or seek nudge, paging. Pressing these three times is using them. */
const MEANT_TO_REPEAT =
  /\b(next|previous|prev|scroll|more|volume|seek|skip|forward|rewind|back|page|zoom|left|right|up|down|increase|decrease|louder|quieter)\b|^[+−-]$/i

/** Errors that are noise, not bugs. */
const IGNORED_ERRORS = [/ResizeObserver loop/i, /^Script error\.?$/i, /AbortError/i]

/** Per session: one report per distinct error, and not many in all. */
const MAX_ERRORS_PER_SESSION = 20

const clicks = new RepeatDetector()
const screens = new PingPongDetector()
const errorsSeen = new Set<string>()
let installed = false

function send(problem: RendererProblem): void {
  void window.api?.mediaHub?.feedback?.reportProblem?.(problem)?.catch(() => {})
}

/** The current screen with ids taken out, so one title page and another
 *  count as the same place. */
export function currentScreen(): string {
  const hash = window.location.hash.replace(/^#/, '') || '/'
  return hash
    .split('?')[0]
    .split('/')
    .map((part) => (/\d/.test(part) || part.length > 24 ? ':id' : part))
    .join('/')
}

function labelOf(element: Element): string {
  const raw =
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    (element.textContent ?? '').replace(/\s+/g, ' ').trim() ||
    element.tagName.toLowerCase()
  return raw.slice(0, 60)
}

function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null
  const control = target?.closest(CONTROL_SELECTOR)
  if (!control || control.closest('[data-repeat-ok]')) return
  const label = labelOf(control)
  if (MEANT_TO_REPEAT.test(label)) return
  const screen = currentScreen()
  const finding = clicks.note(`${screen}|${label}`, Date.now())
  if (!finding) return
  send({
    kind: 'friction',
    title:
      finding.pattern === 'rapid'
        ? `"${label}" pressed ${finding.count} times in quick succession`
        : `"${label}" pressed ${finding.count} times within ${Math.round(finding.spanMs / 1000)} s`,
    context: {
      control: label,
      screen,
      pattern: finding.pattern,
      count: finding.count,
      seconds: Math.round(finding.spanMs / 1000)
    }
  })
}

function reportError(title: string, stack: string | undefined, origin: string): void {
  if (!title || IGNORED_ERRORS.some((pattern) => pattern.test(title))) return
  if (errorsSeen.has(title) || errorsSeen.size >= MAX_ERRORS_PER_SESSION) return
  errorsSeen.add(title)
  send({ kind: 'error', title, stack, context: { origin, screen: currentScreen() } })
}

function describe(value: unknown): { title: string; stack?: string } {
  if (value instanceof Error) {
    const kind = value.name && value.name !== 'Error' ? `${value.name}: ` : ''
    return { title: `${kind}${value.message}`, stack: value.stack }
  }
  return { title: typeof value === 'string' ? value : String(value) }
}

/** A render error caught by an error boundary. */
export function reportRenderError(error: Error, componentStack?: string | null): void {
  const { title } = describe(error)
  reportError(title, [error.stack, componentStack].filter(Boolean).join('\n'), 'render')
}

/** Called on every screen change (see RouteWatcher in MainApp.tsx). */
export function noteScreen(): void {
  const finding = screens.note(currentScreen(), Date.now())
  if (!finding) return
  send({
    kind: 'friction',
    title: `Went back and forth between ${finding.a} and ${finding.b}`,
    context: { from: finding.a, to: finding.b, seconds: Math.round(finding.spanMs / 1000) }
  })
}

/** Once per window. Harmless where there is no bridge (the web preview).
 *  `watchClicks` is off for the player controls overlay, where pressing
 *  play, pause and seek over and over is simply watching something. */
export function installRendererDiagnostics({ watchClicks }: { watchClicks: boolean }): void {
  if (installed || !window.api?.mediaHub?.feedback) return
  installed = true
  // Capture phase, passive: sees the click even if a handler stops it, and
  // never delays it.
  if (watchClicks) window.addEventListener('click', onClick, { capture: true, passive: true })
  window.addEventListener('error', (event) => {
    const { title, stack } = describe(event.error ?? event.message)
    reportError(title, stack, 'window.onerror')
  })
  window.addEventListener('unhandledrejection', (event) => {
    const { title, stack } = describe(event.reason)
    reportError(title, stack, 'unhandledrejection')
  })
}
