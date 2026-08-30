'use client'

// The one question this app asks before you use it.
//
// It exists because the answer cannot be guessed and cannot be quietly
// defaulted: writing video onto somebody's disk when they did not want that
// is the kind of thing you have to ask about, and asking it later — after
// the first film has already been buffered to disk — is asking too late.
//
// SHOWN ONCE, AND ONLY WHEN GENUINELY UNANSWERED. That is why the snapshot
// carries storagePolicyChosen separately from storeMedia: once the flag is a
// boolean, "no" and "never asked" look identical, and only one of them
// should raise a dialog.
//
// It is deliberately not dismissable. There is no default that is safe in
// both directions — assuming yes writes to a disk somebody may be protecting,
// assuming no silently disables caching for everybody else — so the honest
// thing is two buttons and no way past them. Both answers are reversible in
// Settings, and the copy says so.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './StoragePolicyPrompt.module.css'

export function StoragePolicyPrompt() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Absent settings means the snapshot has not arrived yet, which is not the
  // same as an unanswered question — asking during the gap would flash a
  // dialog at somebody who answered it months ago.
  const visible = Boolean(mediaHubSettings) && !mediaHubSettings?.storagePolicyChosen

  // FOCUS GOES IN, AND STAYS IN.
  //
  // The scrim stops a mouse but not a keyboard: without this, Tab walked
  // straight past the dialog into the app behind it, where somebody could
  // start playing something — and an unanswered policy still resolves to
  // the disk default, so video would be written before the question that
  // governs it had been answered. The rest of the app is made inert in
  // AppShell for the same reason; this is the half that keeps focus here.
  useEffect(() => {
    const panel = panelRef.current
    if (!visible || !panel) return
    const previous = document.activeElement as HTMLElement | null
    panel.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      // Wrapping both ways, and treating the panel itself as "before the
      // first" — it holds focus on mount, so a first Shift+Tab would
      // otherwise leave through the top.
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // Capturing, so nothing downstream can consume Tab before this sees it.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Answering it hands focus back where it came from rather than
      // dropping it on the document body.
      previous?.focus?.()
    }
  }, [visible])

  if (!visible) return null

  const answer = async (storeMedia: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.api?.mediaHub?.settings.setStoreMedia(storeMedia)
      refreshMediaHubSettings()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.scrim} role="presentation">
      <div
        ref={panelRef}
        className={`${styles.panel} glass-panel`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-policy-title"
        // Focusable so focus can be put HERE on mount rather than on one of
        // the two answers — landing on a button reads as that answer being
        // preselected, and neither is.
        tabIndex={-1}
      >
        <span className={styles.mark} aria-hidden="true">
          <Icon name="downloads" size={22} />
        </span>
        <h1 id="storage-policy-title" className={styles.title}>
          Keep media on this device?
        </h1>
        <p className={styles.body}>
          While something plays, R3 buffers it ahead so you can rewind and resume without
          re-fetching. That buffer can live on your disk, or only in memory.
        </p>
        <ul className={styles.points}>
          <li>
            <strong>Keep it</strong> — buffers to disk. Rewind freely, resume later, and a title you
            return to starts instantly.
          </li>
          <li>
            <strong>Stream only</strong> — nothing about what you watch is written to disk. A
            shorter buffer, and a faster connection helps.
          </li>
        </ul>
        <p className={styles.note}>
          Either way your library, watch history and settings are saved as normal — this is about
          video. You can change it whenever you like in Settings.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void answer(false)}
          >
            Stream only
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void answer(true)}
          >
            Keep media on this device
          </button>
        </div>
      </div>
    </div>
  )
}
