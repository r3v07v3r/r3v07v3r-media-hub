'use client'

// The control centre: the settings and system surface that folds down from
// the top bar.
//
// It exists because settings outgrew a page. There are ~4,900 lines of
// settings UI across five files, and they were all one long scroll reached
// from the sidebar's "More" group. This gives them a surface with room, and
// a colour shift (see ControlCentre.module.css) that makes it obvious you
// have moved into a different mode rather than another page.
//
// The sections themselves are hosted, not rewritten — they arrive as
// `children` exactly as they render today.

import { useCallback, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAppState } from '@renderer/context/AppStateContext'
import { useMotionUserDisabled } from '@renderer/hooks/useMotionUserDisabled'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './ControlCentre.module.css'

/**
 * The cube's side, in dvh — and therefore how tall the control centre is.
 *
 * A cube needs a KNOWN side length: both faces are placed at half of it
 * along Z, so this cannot be `auto` or the two faces stop meeting at an
 * edge and the solid comes apart mid-rotation. 88 leaves the app visible
 * behind the stage at the bottom, which is what keeps it feeling like a
 * panel over the app rather than a page swap.
 */
const CUBE_HEIGHT_VH = 88

/** Everything focusable, for the tab trap. Excludes anything explicitly
 *  removed from the tab order so a disabled control cannot swallow focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ControlCentre({ children }: { children: React.ReactNode }) {
  const { controlCentreOpen, setControlCentreOpen } = useAppState()
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** What had focus before the panel opened, so closing can hand it back
   *  rather than dumping the caret at the top of the document. */
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => setControlCentreOpen(false), [setControlCentreOpen])

  // Remember the trigger on the way in, restore it on the way out. Captured
  // in the same effect that moves focus, so the two can never disagree about
  // which element they are talking about.
  useEffect(() => {
    if (!controlCentreOpen) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    // Focus the panel itself rather than its first control: landing on a
    // toggle means a screen reader announces that toggle instead of the
    // dialog, and one stray keypress changes a setting.
    const id = window.requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(id)
      const target = returnFocusRef.current
      returnFocusRef.current = null
      // Only if it is still in the document — the trigger can legitimately
      // have unmounted while the panel was open.
      if (target && document.contains(target)) target.focus()
    }
  }, [controlCentreOpen])

  // Escape closes; Tab cycles inside. Bound to the panel rather than the
  // window so it cannot intercept keys meant for the player or a dialog
  // opened on top of this one.
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
        // Nothing to cycle between: keep focus on the panel rather than
        // letting Tab escape to the app behind the scrim.
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

  // The standing "UI animations" preference (Settings > More Options). When
  // it is off, the panel appears instantly — a 3D fold is exactly the
  // decorative motion that toggle exists to stop.
  //
  // Deliberately NOT gated on data-motion-suspended, the automatic
  // hidden/playing flag. That one pauses ambient CSS animation, and this is
  // a one-shot entrance: GlobalOverlays already documents what happens when
  // an entrance gets frozen mid-way — PlaybackOverlay stuck at opacity 0,
  // functional and invisible. These transforms are also driven by
  // framer-motion in JS, which the CSS suspend rule could not stop anyway.
  const motionOff = useMotionUserDisabled()
  const duration = motionOff ? 0 : 0.52
  // Closing is faster than opening on purpose. Opening is the moment worth
  // dressing; closing is something you do to get back to what you were
  // doing, and matching the two makes dismissal feel sticky.
  const exitDuration = motionOff ? 0 : 0.32
  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <AnimatePresence>
      {controlCentreOpen && (
        <motion.div
          className={styles.stage}
          style={
            {
              // The cube's side length, and half of it. Both faces are placed
              // by the second value, so it has to be exactly half the first or
              // the solid comes apart at the edge.
              '--cc-height': `${CUBE_HEIGHT_VH}dvh`,
              '--cc-depth': `${CUBE_HEIGHT_VH / 2}dvh`
            } as React.CSSProperties
          }
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: motionOff ? 0 : 0.24, ease }}
          onMouseDown={(event) => {
            // Only a click on the stage itself, so a drag that ends outside
            // the panel (selecting text, releasing a slider) does not close it.
            if (event.target === event.currentTarget) close()
          }}
        >
          {/* The CUBE rotates — not the panel. That distinction is the whole
              difference between this and a lid flapping open: the container
              turns, carrying both faces, so through the middle of the
              movement the lid and the panel are on screen together, meeting
              at their shared edge.

              No opacity on this element. Fading a 3D solid in makes it read
              as a picture of a cube rather than a cube; the faces are opaque
              and the rotation alone does the work. */}
          <motion.div
            className={styles.cube}
            // The cube is pushed BACK by exactly the depth its front face is
            // pushed forward, so that face lands on the screen plane (z = 0)
            // instead of floating toward the viewer.
            //
            // Without this the panel is magnified by perspective/(perspective
            // - depth): about 1.15x in a small window and ~1.45x in a full
            // one, which crops the header — caught by seeing the title render
            // as "OL HUB" with its left edge off screen. transformTemplate is
            // how the order is guaranteed: translate first, then rotate, so
            // the rotation still happens about the cube's own centre.
            transformTemplate={({ rotateX }) =>
              `translateZ(-${CUBE_HEIGHT_VH / 2}dvh) rotateX(${rotateX})`
            }
            initial={{ rotateX: -90 }}
            animate={{ rotateX: 0 }}
            exit={{ rotateX: -90, transition: { duration: exitDuration, ease } }}
            transition={{ duration, ease }}
          >
            <div className={`${styles.face} ${styles.faceLid}`} aria-hidden="true" />
            <div
              ref={panelRef}
              className={`${styles.face} ${styles.panel}`}
              role="dialog"
              aria-modal="true"
              aria-label="Control centre"
              tabIndex={-1}
              onKeyDown={onKeyDown}
            >
            <div className={styles.hinge} aria-hidden="true" />
            <header className={styles.header}>
              <div>
                <h2 className={styles.title}>R3 Media Control Hub</h2>
                <p className={styles.subtitle}>System &amp; Settings</p>
              </div>
              <button type="button" className={styles.close} onClick={close} aria-label="Close control centre">
                <Icon name="x" />
              </button>
            </header>
            {/* Content fades in a beat after the fold starts, so it is not
                read mid-rotation — the mock's "content cross-fades" note. */}
            <motion.div
              className={styles.body}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: motionOff ? 0 : 0.3,
                delay: motionOff ? 0 : 0.18,
                ease
              }}
            >
              <div className={styles.content}>{children}</div>
            </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
