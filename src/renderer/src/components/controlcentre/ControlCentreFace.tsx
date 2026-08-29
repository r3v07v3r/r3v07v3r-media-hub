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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import SettingsPage from '@renderer/routes/SettingsPage'
import styles from './ControlCentre.module.css'
import { CachingSection } from './sections/CachingSection'
import { PipelineSection } from './sections/PipelineSection'
import { ServicesSection } from './sections/ServicesSection'
import { ControlCentreNav } from './ControlCentreNav'
import {
  CONTROL_CENTRE_SECTIONS,
  DEFAULT_CONTROL_CENTRE_SECTION,
  type ControlCentreSectionId
} from './sections'

/** Everything focusable, for the tab trap. Excludes anything explicitly
 *  removed from the tab order so a disabled control cannot swallow focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ControlCentreFace() {
  const { controlCentreOpen, setControlCentreOpen } = useAppState()
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Kept across opens on purpose. Coming back to the section you were last
  // in is what a control centre does; resetting to the front page every
  // time the cube turns would make a two-step task a four-step one.
  const [section, setSection] = useState<ControlCentreSectionId>(DEFAULT_CONTROL_CENTRE_SECTION)
  /** What had focus before this face turned toward the viewer, so turning
   *  away can hand it back rather than dumping the caret at the top of the
   *  document. */
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => setControlCentreOpen(false), [setControlCentreOpen])

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
      <div className={styles.layout}>
        <ControlCentreNav active={section} onSelect={setSection} />
        <div className={styles.body}>
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
              {entry.id === 'settings' ? <SettingsPage embedded /> : null}
              {entry.id === 'caching' ? <CachingSection /> : null}
              {entry.id === 'pipeline' ? <PipelineSection /> : null}
              {entry.id === 'services' ? <ServicesSection /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
