// D-pad/keyboard navigation for a screen with no mouse — a TV remote or a
// keyboard's arrow keys. The geometry is a pure, DOM-free function (unit
// testable, and reusable if this ever needs to run somewhere without a
// DOM at all); useSpatialNav is the thin DOM/React shell around it,
// installed once at the app root.
import { useEffect } from 'react'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Just the geometry findNextTarget needs — a DOMRect satisfies this
 *  structurally, so callers can pass one straight through. */
export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

/**
 * The index in `rects` best reached from `current` by moving `direction`,
 * or -1 when nothing lies that way.
 *
 * "Best" is nearest by centre-to-centre distance, with movement ACROSS the
 * direction of travel penalised 3x relative to movement ALONG it — pressing
 * Down should walk to the tile below, not jump sideways to one that is
 * merely a little closer in a straight line. Anything not strictly ahead in
 * `direction` (including `current` itself, which is never ahead of itself)
 * is excluded outright rather than merely scored low.
 */
export function findNextTarget(
  rects: readonly Rect[],
  current: Rect,
  direction: Direction
): number {
  const cx = current.left + current.width / 2
  const cy = current.top + current.height / 2
  // A little slack so a tile in the exact same row/column as `current`
  // still counts as "ahead" rather than being rejected by float rounding.
  const EPSILON = 1

  let bestIndex = -1
  let bestScore = Infinity

  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    const tx = rect.left + rect.width / 2
    const ty = rect.top + rect.height / 2
    const dx = tx - cx
    const dy = ty - cy

    if (direction === 'up' && dy > -EPSILON) continue
    if (direction === 'down' && dy < EPSILON) continue
    if (direction === 'left' && dx > -EPSILON) continue
    if (direction === 'right' && dx < EPSILON) continue

    const vertical = direction === 'up' || direction === 'down'
    const along = Math.abs(vertical ? dy : dx)
    const across = Math.abs(vertical ? dx : dy)
    const score = along + across * 3
    if (score < bestScore) {
      bestScore = score
      bestIndex = index
    }
  }

  return bestIndex
}

const FOCUSABLE_SELECTOR = 'a[href], button, input, [tabindex="0"]'
const ARROW_DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

function isTextInput(element: Element | null): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement && element.type !== 'submit' && element.type !== 'button'
  )
}

function visibleFocusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && element.offsetParent !== null
  )
}

/**
 * Installs D-pad/keyboard navigation for the whole app: arrow keys move
 * focus between visible `a[href]`/`button`/`input`/`[tabindex="0"]`
 * elements by on-screen position, and Escape/Backspace/the remote's
 * BrowserBack key go back — mounted once at the app root (see App.tsx).
 *
 * Arrow keys inside a text input are ambiguous — Left/Right could mean
 * "move the caret" or "move focus" — so this keeps the simple rule the
 * task calls for: Up/Down always leave the field (there is no in-field
 * meaning for them), Left/Right stay in it and edit the caret.
 */
export function useSpatialNav(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const active = document.activeElement
      const inTextInput = isTextInput(active)

      if (event.key === 'Escape' || event.key === 'BrowserBack') {
        window.history.back()
        return
      }
      if (event.key === 'Backspace' && !inTextInput) {
        event.preventDefault()
        window.history.back()
        return
      }

      const direction = ARROW_DIRECTIONS[event.key]
      if (!direction) return
      if (inTextInput && (direction === 'left' || direction === 'right')) return

      const elements = visibleFocusables()
      if (!elements.length) return
      const currentIndex = active instanceof HTMLElement ? elements.indexOf(active) : -1

      // Nothing focused yet (a fresh page, or focus landed on <body>) —
      // the first arrow press should put focus somewhere rather than do
      // nothing, so it lands on the first focusable element.
      if (currentIndex === -1) {
        event.preventDefault()
        elements[0].focus()
        return
      }

      const rects = elements.map((element) => element.getBoundingClientRect())
      const nextIndex = findNextTarget(rects, rects[currentIndex], direction)
      if (nextIndex === -1) return

      event.preventDefault()
      const target = elements[nextIndex]
      target.focus()
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}
