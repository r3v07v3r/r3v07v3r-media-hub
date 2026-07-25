import { useEffect, useState } from 'react'
import styles from './ReferenceOverlay.module.css'

// Dev-only pixel-alignment tool (spec: "reference-overlay pixel-alignment
// debug tool — F8 toggle, F9/F10/F11 opacity presets"). Lays the source
// reference screenshot over the live app at an adjustable opacity so the
// composition can be checked against it pixel-for-pixel while building at
// the fixed 1920x1080 design canvas. Ships in every build (not just dev)
// since this is a small, inert, opt-in overlay — it renders nothing unless
// a developer explicitly toggles it on.
const OPACITY_PRESETS: Record<string, number> = {
  F9: 0.25,
  F10: 0.5,
  F11: 0.75
}

export function ReferenceOverlay() {
  const [visible, setVisible] = useState(false)
  const [opacity, setOpacity] = useState(0.5)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'F8') {
        e.preventDefault()
        setVisible((v) => !v)
        return
      }
      if (e.key in OPACITY_PRESETS) {
        e.preventDefault()
        setOpacity(OPACITY_PRESETS[e.key])
        setVisible(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!visible) return null

  return (
    <>
      <img
        src="/reference/dashboard-reference.png"
        alt=""
        aria-hidden="true"
        className={styles.overlay}
        style={{ opacity }}
      />
      <div className={styles.badge} aria-hidden="true">
        Reference overlay — {Math.round(opacity * 100)}% — F8 hide · F9/F10/F11 opacity
      </div>
    </>
  )
}
