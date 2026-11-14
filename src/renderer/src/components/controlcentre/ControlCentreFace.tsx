'use client'

// The control centre — the settings and system surface that occupies the
// SECOND FACE of the app's cube (see AppShell, which owns the cube itself).
//
// It is a face, not an overlay, and that distinction is the whole design: the
// app is one side of a solid, this is the other, and the R3 bar is the edge
// they share. An overlay floating over a static app was the first attempt and
// read exactly like what it was.
//
// Consequences of being a face rather than an overlay, all deliberate:
//   - It does not mount and unmount per open. A cube's far side does not stop
//     existing because it is facing away, and an empty face during the
//     roll-back would break the illusion at the worst moment.
//   - It carries no transition of its own. The cube's rotation is the
//     transition; anything animating in here would be a second, competing one.
//
// The settings sections are HOSTED, not rewritten — they render exactly as
// they do on the old page.

import { useCallback, useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import SettingsPage, { type SettingsCategory } from '@renderer/routes/SettingsPage'
import styles from './ControlCentre.module.css'
import { CachingSection } from './sections/CachingSection'
import { FeedbackSection } from './sections/FeedbackSection'
import { PipelineSection } from './sections/PipelineSection'
import { ServicesSection } from './sections/ServicesSection'
import { UpdatesSection } from './sections/UpdatesSection'
import { ControlCentreNav } from './ControlCentreNav'
import { PanelVisibleContext } from './panelVisibility'
import { MatrixRain } from './MatrixRain'
import { CONTROL_CENTRE_SECTIONS, SETTINGS_CATEGORY_FOR } from './sections'

/** Everything focusable, for the tab trap. Excludes anything explicitly
 *  removed from the tab order so a disabled control cannot swallow focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** How far `el` sits below the top of `scroller`'s content, from the
 *  untransformed layout (offsetTop chains), less a little air. */
function offsetWithin(el: HTMLElement, scroller: HTMLElement): number {
  const top = (node: HTMLElement): number => {
    let sum = 0
    for (let at: HTMLElement | null = node; at; at = at.offsetParent as HTMLElement | null) {
      sum += at.offsetTop
    }
    return sum
  }
  return Math.max(0, top(el) - top(scroller) - scroller.clientTop - 12)
}

export function ControlCentreFace() {
  const {
    controlCentreOpen,
    setControlCentreOpen,
    controlCentreSection: section,
    setControlCentreSection: setSection,
    controlCentreAnchor,
    clearControlCentreAnchor
  } = useAppState()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // The section lives in AppStateContext, kept across opens on purpose:
  // coming back to the section you were last in is what a control centre
  // does, and a "Set up Simkl" button elsewhere in the app opens the centre
  // at its section (openControlCentre).
  /** What had focus before this face turned toward the viewer, so turning
   *  away can hand it back rather than dumping the caret at the top of the
   *  document. */
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => setControlCentreOpen(false), [setControlCentreOpen])

  // Opened AT a heading: scroll it into view once its panel is the one
  // showing, and put focus there so a screen reader lands on the service
  // asked for rather than the panel. Two frames: the first lets the
  // hidden attribute flip, the second lets layout settle before scrolling.
  // The panel's own scroller is moved, instantly, rather than
  // scrollIntoView: that runs during the cube's turn and would also scroll
  // the cube's clipped containers, measured from rotated rects. offsetTop
  // ignores the transform, so the distance is the flat one.
  useEffect(() => {
    if (!controlCentreOpen || !controlCentreAnchor) return
    let second = 0
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const target = document.getElementById(controlCentreAnchor)
        if (target) {
          if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
          const body = bodyRef.current
          if (body && body.contains(target)) {
            body.scrollTo({ top: offsetWithin(target, body), behavior: 'auto' })
          }
          target.focus({ preventScroll: true })
        }
        clearControlCentreAnchor()
      })
    })
    return () => {
      window.cancelAnimationFrame(first)
      window.cancelAnimationFrame(second)
    }
  }, [controlCentreOpen, controlCentreAnchor, section, clearControlCentreAnchor])

  useEffect(() => {
    if (!controlCentreOpen) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    // Focus the panel itself rather than its first control: landing on a
    // toggle means a screen reader announces that toggle instead of the
    // surface, and one stray keypress changes a setting.
    const id = window.requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(id)
      const target = returnFocusRef.current
      returnFocusRef.current = null
      // Only if it is still in the document — the trigger can legitimately
      // have unmounted in the meantime.
      if (target && document.contains(target)) target.focus()
    }
  }, [controlCentreOpen])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (!focusable.length) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [close]
  )

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-modal="true"
      aria-label="Control centre"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Kept out of the tab order entirely while facing away, so Tab from the
      // app cannot land on a control that is physically behind it. This is
      // the one thing a face needs that an overlay did not: the far side is
      // still in the document, so it has to be made unreachable explicitly
      // rather than by not existing.
      inert={!controlCentreOpen}
    >
      {/* No header and no close button, deliberately. The R3 bar directly
          above this face is the edge the two faces share: it already says
          which side you are looking at (see Brand, which relabels itself),
          and its cog is what turns the cube back. A heading here repeated
          the bar, and a close button repeated the cog.

          Escape still closes — that is a keyboard affordance, not a
          duplicated control. */}
      {/* Behind the layout, and told when the face is actually facing the
          viewer — there is no point drawing rain onto a side of a cube that
          is turned away. */}
      <MatrixRain active={controlCentreOpen} />
      <div className={styles.layout}>
        <ControlCentreNav active={section} onSelect={setSection} />
        <div className={styles.body} ref={bodyRef}>
          {CONTROL_CENTRE_SECTIONS.map((entry) => (
            <div
              key={entry.id}
              id={`cc-panel-${entry.id}`}
              role="tabpanel"
              aria-labelledby={`cc-tab-${entry.id}`}
              // Unmounting the inactive panels would throw away every bit of
              // in-progress state in them — a half-typed server URL, a
              // pending pairing poll — each time somebody looked at another
              // section. Hidden and inert keeps them out of the tab order
              // and out of the accessibility tree without that cost.
              hidden={entry.id !== section}
              inert={entry.id !== section}
              className={styles.content}
            >
              {SETTINGS_CATEGORY_FOR[entry.id] ? (
                <SettingsPage
                  embedded
                  category={SETTINGS_CATEGORY_FOR[entry.id] as SettingsCategory}
                />
              ) : null}
              <PanelVisibleContext.Provider value={controlCentreOpen && entry.id === section}>
                {entry.id === 'caching' ? <CachingSection /> : null}
                {entry.id === 'pipeline' ? <PipelineSection onNavigate={setSection} /> : null}
                {entry.id === 'services' ? <ServicesSection /> : null}
                {entry.id === 'updates' ? <UpdatesSection /> : null}
                {entry.id === 'feedback' ? <FeedbackSection /> : null}
              </PanelVisibleContext.Provider>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
