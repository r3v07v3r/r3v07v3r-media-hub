import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import overlayStyles from '../overlays/Overlays.module.css'
import styles from './ProfilePinPrompt.module.css'

/** Rendered from GlobalOverlays.tsx, driven entirely by AppStateContext's
 *  profilePinPrompt — switchProfile() sets that instead of switching
 *  outright whenever the target profile has a PIN (see profiles.ts's
 *  verify-pin handler for where the PIN itself is actually checked; this
 *  component never sees or stores the PIN beyond the single request). */
export function ProfilePinPrompt() {
  const { profilePinPrompt, switchProfile, cancelProfilePinPrompt } = useAppState()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!profilePinPrompt) return null

  async function submit() {
    if (!profilePinPrompt || pin.length < 4) return
    setBusy(true)
    setError(null)
    try {
      const api = window.api?.mediaHub?.profiles
      const result = await api?.verifyPin(profilePinPrompt.id, pin)
      if (!result?.ok) {
        setError('Incorrect PIN.')
        setBusy(false)
        return
      }
      switchProfile(profilePinPrompt.id, pin)
      setPin('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify PIN.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={overlayStyles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`Enter PIN for ${profilePinPrompt.name}`}
      onClick={cancelProfilePinPrompt}
    >
      <div className={`${styles.card} glass-panel`} onClick={(e) => e.stopPropagation()}>
        <span
          className={styles.avatar}
          style={{
            background: `linear-gradient(135deg, ${profilePinPrompt.avatarTint[0]}, ${profilePinPrompt.avatarTint[1]})`
          }}
          aria-hidden="true"
        >
          {profilePinPrompt.avatarInitial}
        </span>
        <h2 className={styles.title}>{profilePinPrompt.name}</h2>
        <p className={styles.subtitle}>Enter PIN to switch profiles</p>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          maxLength={8}
          className={styles.pinInput}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, ''))
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') cancelProfilePinPrompt()
          }}
          aria-label="PIN"
        />
        {error && <span className={styles.error}>{error}</span>}
        <div className={styles.actions}>
          <button type="button" className={styles.cancelButton} onClick={cancelProfilePinPrompt}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.submitButton}
            disabled={pin.length < 4 || busy}
            onClick={submit}
          >
            {busy ? <Icon name="refresh" size={14} /> : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  )
}
