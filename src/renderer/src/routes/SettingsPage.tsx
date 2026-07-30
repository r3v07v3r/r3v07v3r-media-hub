import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { AboutUpdateSection } from './AboutUpdateSection'
import { MediaServicesSection } from './MediaServicesSection'
import { MediaHubSettingsSections } from './MediaHubSettingsSections'
import type { ProfilePublic } from '@shared/media-hub/types'
import styles from './Settings.module.css'

const PLAYBACK_BUFFER_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'extra', label: 'Extra' },
  { value: 'maximum', label: 'Maximum' }
]

function SegmentedRow({
  icon,
  title,
  description,
  value,
  options,
  onChange
}: {
  icon: string
  title: string
  description: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowIcon} aria-hidden="true">
        <Icon name={icon} size={17} />
      </div>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDescription}>{description}</span>
      </div>
      <div className={styles.segmentGroup} role="radiogroup" aria-label={title}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={`${styles.segmentButton} ${value === option.value ? styles.segmentButtonActive : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange
}: {
  icon: string
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowIcon} aria-hidden="true">
        <Icon name={icon} size={17} />
      </div>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDescription}>{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.switchThumb} />
      </button>
    </div>
  )
}

/** Inline add/edit form shown below the profile grid — one component for
 *  both create and edit, since the fields are identical apart from a
 *  Delete button and pre-filled values in edit mode. */
function ProfileForm({
  target,
  activeProfileId,
  profileCount,
  onClose
}: {
  target: ProfilePublic | null // null = creating a new profile
  activeProfileId: string
  profileCount: number
  onClose: () => void
}) {
  const { createProfile, updateProfile, deleteProfile } = useAppState()
  const [name, setName] = useState(target?.name ?? '')
  const [isKid, setIsKid] = useState(target?.isKid ?? false)
  const [pin, setPin] = useState('')
  const [removePin, setRemovePin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isEdit = Boolean(target)
  const isActive = target?.id === activeProfileId
  const canDelete = isEdit && !isActive && profileCount > 1

  async function handleSave() {
    if (pin && !/^\d{4,8}$/.test(pin)) {
      setError('PIN must be 4-8 digits.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (target) {
        await updateProfile({
          id: target.id,
          name,
          isKid,
          pin: removePin ? null : pin || undefined
        })
      } else {
        await createProfile({ name, isKid, pin: pin || undefined })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this profile.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await deleteProfile(target.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this profile.')
      setBusy(false)
    }
  }

  return (
    <div className={styles.profileForm}>
      <div className={styles.profileFormRow}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <input
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{target?.hasPin ? 'New PIN' : 'PIN (optional)'}</span>
          <input
            className={styles.fieldInput}
            type="password"
            inputMode="numeric"
            value={pin}
            disabled={removePin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder={target?.hasPin ? 'Keep current PIN' : '4-8 digits'}
          />
        </div>
      </div>

      <div className={styles.row} style={{ padding: 0 }}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Kids profile</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isKid}
          aria-label="Kids profile"
          className={`${styles.switch} ${isKid ? styles.switchOn : ''}`}
          onClick={() => setIsKid((v) => !v)}
        >
          <span className={styles.switchThumb} />
        </button>
      </div>

      {target?.hasPin && (
        <div className={styles.row} style={{ padding: 0 }}>
          <div className={styles.rowText}>
            <span className={styles.rowTitle}>Remove PIN</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={removePin}
            aria-label="Remove PIN"
            className={`${styles.switch} ${removePin ? styles.switchOn : ''}`}
            onClick={() => setRemovePin((v) => !v)}
          >
            <span className={styles.switchThumb} />
          </button>
        </div>
      )}

      {error && (
        <span className={`${styles.statusMessage} ${styles.statusError}`}>{error}</span>
      )}

      <div className={styles.profileFormActions}>
        {isEdit && (
          <button
            type="button"
            className={styles.profileDeleteButton}
            disabled={!canDelete || busy}
            onClick={handleDelete}
            title={
              isActive
                ? 'Switch to a different profile before deleting this one'
                : !canDelete
                  ? 'At least one profile must remain'
                  : undefined
            }
          >
            Delete
          </button>
        )}
        <button type="button" className={styles.testButton} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSave}
          disabled={busy || !name.trim()}
        >
          {isEdit ? 'Save' : 'Add profile'}
        </button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const {
    performancePanelVisible,
    setPerformancePanelVisible,
    isOffline,
    setIsOffline,
    profiles,
    activeProfileId,
    switchProfile,
    mediaHubSettings,
    refreshMediaHubSettings
  } = useAppState()
  // null = no form open, 'new' = create form, otherwise the id of the
  // profile being edited.
  const [editingProfile, setEditingProfile] = useState<string | 'new' | null>(null)

  async function handleSetPlaybackBuffer(preset: string) {
    await window.api?.mediaHub?.settings.setPlaybackBuffer(preset)
    refreshMediaHubSettings()
  }

  // Sections tile left-to-right instead of stacking in one long vertical
  // scroll (see .tileArea in Settings.module.css) — a plain vertical mouse
  // wheel has nothing to act on there (no vertical overflow), so it has to
  // be translated into horizontal scrolling explicitly. A native listener,
  // not React's onWheel: React attaches wheel handlers as passive by
  // default, and preventDefault on a passive listener is a silent no-op
  // (plus a console warning) — this needs to actually stop the page from
  // trying to rubber-band-scroll vertically instead.
  const tileAreaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = tileAreaRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (e.deltaY === 0) return
      e.preventDefault()
      el!.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>Settings</h1>

      <div className={styles.tileArea} ref={tileAreaRef}>
        <AboutUpdateSection />

        <section className={`${styles.section} glass-panel`} aria-labelledby="settings-perf">
          <h2 id="settings-perf" className={styles.sectionTitle}>
            Performance &amp; Display
          </h2>
          <ToggleRow
            icon="cpu"
            title="System performance panel"
            description="Show live CPU, GPU, RAM, and network gauges on the Home dashboard."
            checked={performancePanelVisible}
            onChange={setPerformancePanelVisible}
          />
          <SegmentedRow
            icon="clock"
            title="Playback buffer"
            description="How long to buffer before playback starts. Higher settings help on a slow or unstable connection at the cost of a longer wait to start."
            value={mediaHubSettings?.playbackBuffer ?? 'auto'}
            options={PLAYBACK_BUFFER_OPTIONS}
            onChange={handleSetPlaybackBuffer}
          />
        </section>

        <section className={`${styles.section} glass-panel`} aria-labelledby="settings-network">
          <h2 id="settings-network" className={styles.sectionTitle}>
            Network
          </h2>
          <ToggleRow
            icon={isOffline ? 'wifi-off' : 'wifi'}
            title="Simulate offline mode"
            description="Preview how R3 behaves without a network connection."
            checked={isOffline}
            onChange={setIsOffline}
          />
        </section>

        <MediaServicesSection />

        <MediaHubSettingsSections />

        <section className={`${styles.section} glass-panel`} aria-labelledby="settings-profiles">
          <h2 id="settings-profiles" className={styles.sectionTitle}>
            Profiles
          </h2>
          <div className={styles.profileGrid}>
            {profiles.map((p) => {
              const active = p.id === activeProfileId
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.profileCard} ${active ? styles.profileCardActive : ''}`}
                  onClick={() => switchProfile(p.id)}
                  aria-pressed={active}
                >
                  <span
                    className={styles.profileAvatar}
                    style={{
                      background: `linear-gradient(135deg, ${p.avatarTint[0]}, ${p.avatarTint[1]})`
                    }}
                  >
                    {p.avatarInitial}
                  </span>
                  <span className={styles.profileName}>{p.name}</span>
                  {p.isKid && <span className={styles.profileBadge}>Kids</span>}
                  {p.hasPin && (
                    <span className={styles.profileBadge} aria-label="PIN-locked">
                      <Icon name="lock" size={10} />
                    </span>
                  )}
                  {active && (
                    <span className={styles.profileCheck} aria-hidden="true">
                      <Icon name="check" size={12} />
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit ${p.name}`}
                    className={styles.profileEditButton}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingProfile(p.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        setEditingProfile(p.id)
                      }
                    }}
                  >
                    <Icon name="edit" size={11} />
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className={styles.profileCardAdd}
              onClick={() => setEditingProfile('new')}
            >
              <span className={styles.profileCardAddIcon}>
                <Icon name="plus" size={18} />
              </span>
              <span className={styles.profileName}>Add Profile</span>
            </button>
          </div>

          <p className={styles.profileNote}>
            Watch history is currently shared across all profiles — per-profile history is
            not built yet.
          </p>

          {editingProfile && (
            <ProfileForm
              target={editingProfile === 'new' ? null : profiles.find((p) => p.id === editingProfile) || null}
              activeProfileId={activeProfileId}
              profileCount={profiles.length}
              onClose={() => setEditingProfile(null)}
            />
          )}
        </section>
      </div>
    </div>
  )
}
