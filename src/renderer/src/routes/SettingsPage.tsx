import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useAsyncAction } from '@renderer/hooks/useAsyncAction'
import { AboutUpdateSection } from './AboutUpdateSection'
import { MediaServicesSection } from './MediaServicesSection'
import {
  TorBoxSection,
  TmdbSection,
  OmdbSection,
  SimklSection,
  MalSection,
  OpenSubtitlesSection,
  WatchPartySection,
  R3PartySyncSection
} from './MediaHubSettingsSections'
import type { NetworkInfoResult, ProfilePublic } from '@shared/media-hub/types'
import styles from './Settings.module.css'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const PLAYBACK_BUFFER_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'extra', label: 'Extra' },
  { value: 'maximum', label: 'Maximum' }
]

const QUALITY_OPTIONS = [
  { value: '0', label: 'Any' },
  { value: '480', label: '480p' },
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: '1440', label: '1440p' },
  { value: '2160', label: '4K' }
]
const SIZE_OPTIONS = [
  { value: '0', label: 'Any' },
  { value: '1', label: '1 GB' },
  { value: '2', label: '2 GB' },
  { value: '5', label: '5 GB' },
  { value: '10', label: '10 GB' },
  { value: '20', label: '20 GB' }
]

// ISO 639-1 codes accepted by OpenSubtitles' `languages` search param (and
// by appIpc.ts's own subtitleLanguage validator regex) — the six most
// requested languages, not an exhaustive list of everything OpenSubtitles
// supports.
// Short labels, not full language names — six full words don't fit
// alongside the row's title/description in this column's fixed width (see
// PLAYBACK_BUFFER_OPTIONS above, which stays short for the same reason).
const SUBTITLE_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'es', label: 'ES' },
  { value: 'fr', label: 'FR' },
  { value: 'de', label: 'DE' },
  { value: 'ja', label: 'JA' },
  { value: 'ko', label: 'KO' }
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
    <div className={`${styles.row} ${styles.rowSegmented}`}>
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

      {error && <span className={`${styles.statusMessage} ${styles.statusError}`}>{error}</span>}

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

/** UI-animations toggle (layers onto global.css's `[data-motion-user-
 *  disabled]` rule via useMotionUserDisabled, see AppShell.tsx) + a real
 *  subtitle-cache-clear button (walks subtitles-cache/ on disk and reports
 *  the actual bytes freed) — the "quick, meaningful" More Options picked
 *  over hardware-accel/video-quality, which have no real mechanism in this
 *  app's TorBox-sourced (not locally re-encoded per quality) pipeline. */
function MoreOptionsSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [clearStatus, setClearStatus] = useState<{
    kind: 'idle' | 'busy' | 'ok' | 'error'
    message?: string
  }>({ kind: 'idle' })
  const runAction = useAsyncAction()

  async function saveSetting(scope: string, action: () => Promise<unknown>) {
    const result = await runAction({
      scope,
      action,
      errorMessage: "Couldn't save that setting.",
      successMessage: 'Setting saved.',
      retry: true
    })
    if (result.ok) refreshMediaHubSettings()
  }

  async function handleToggleAnimations(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.ui-animations', () => api.settings.setUiAnimations(enabled))
  }

  async function handleToggleVideoTranscode(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.video-transcode', () => api.settings.setVideoTranscode(enabled))
  }

  async function handleToggleHideWatched(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.hide-watched', () =>
        api.settings.setHideDefaults({ hideWatchedDefault: enabled })
      )
  }

  async function handleToggleHideCompleted(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.hide-completed', () =>
        api.settings.setHideDefaults({ hideCompletedDefault: enabled })
      )
  }

  async function handleToggleHideDisliked(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.hide-disliked', () =>
        api.settings.setHideDefaults({ hideDislikedDefault: enabled })
      )
  }

  async function handleClearSubtitleCache() {
    const api = window.api?.mediaHub?.subtitles
    if (!api) return
    setClearStatus({ kind: 'busy' })
    try {
      const result = await api.clearCache()
      setClearStatus({ kind: 'ok', message: `Freed ${formatBytes(result.freedBytes)}.` })
    } catch (error) {
      setClearStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not clear the cache.'
      })
    }
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-more">
      <h2 id="settings-more" className={styles.sectionTitle}>
        More Options
      </h2>
      <ToggleRow
        icon="sparkle"
        title="UI animations"
        description="Decorative ambient motion (sidebar highlights, background drift). Playback already pauses these automatically — this turns them off everywhere, all the time."
        checked={mediaHubSettings?.uiAnimationsEnabled ?? true}
        onChange={handleToggleAnimations}
      />
      <ToggleRow
        icon="cpu"
        title="Convert incompatible video (experimental)"
        description="For titles whose video format doesn't play reliably here (e.g. HEVC). Only runs if a real hardware encoder is found on this machine — off by default, and silently has no effect otherwise. Off, you'll still get a warning instead of an unexplained crash."
        checked={mediaHubSettings?.videoTranscodeEnabled ?? false}
        onChange={handleToggleVideoTranscode}
      />
      <ToggleRow
        icon="eye-off"
        title="Hide watched by default"
        description="Movies you've watched, and series/anime you've started, are hidden from Movies/Series/Anime browsing and Mood Browser out of the box. Overridable per-page from that page's filter bar."
        checked={mediaHubSettings?.hideWatchedDefault ?? false}
        onChange={handleToggleHideWatched}
      />
      <ToggleRow
        icon="check"
        title="Hide completed by default"
        description="Series/anime where every aired episode has been watched are hidden by default. A show you're still partway through stays visible."
        checked={mediaHubSettings?.hideCompletedDefault ?? false}
        onChange={handleToggleHideCompleted}
      />
      <ToggleRow
        icon="thumbs-down"
        title="Hide disliked by default"
        description="Anything marked “Not interested” (see a title's context menu) is hidden by default, everywhere it would otherwise appear."
        checked={mediaHubSettings?.hideDislikedDefault ?? false}
        onChange={handleToggleHideDisliked}
      />
      <div className={styles.row}>
        <div className={styles.rowIcon} aria-hidden="true">
          <Icon name="trash" size={17} />
        </div>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Subtitle cache</span>
          <span className={styles.rowDescription}>
            Downloaded subtitle files kept on disk for compatibility-mode playback.
          </span>
        </div>
        <button
          type="button"
          className={styles.testButton}
          onClick={handleClearSubtitleCache}
          disabled={clearStatus.kind === 'busy'}
        >
          {clearStatus.kind === 'busy' ? 'Clearing…' : 'Clear cache'}
        </button>
      </div>
      {clearStatus.kind !== 'idle' && clearStatus.kind !== 'busy' && (
        <span
          className={`${styles.statusMessage} ${clearStatus.kind === 'ok' ? styles.statusOk : styles.statusError}`}
        >
          {clearStatus.message}
        </span>
      )}
    </section>
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
  const [networkInfo, setNetworkInfo] = useState<NetworkInfoResult | null>(null)
  const [speedTest, setSpeedTest] = useState<{
    kind: 'idle' | 'busy' | 'ok' | 'error'
    message?: string
    quality?: number
    size?: number
  }>({ kind: 'idle' })
  const runAction = useAsyncAction()

  async function saveSetting(scope: string, action: () => Promise<unknown>) {
    const result = await runAction({
      scope,
      action,
      errorMessage: "Couldn't save that setting.",
      successMessage: 'Setting saved.',
      retry: true
    })
    if (result.ok) refreshMediaHubSettings()
  }

  useEffect(() => {
    window.api?.mediaHub?.network
      .info()
      .then(setNetworkInfo)
      .catch(() => {})
  }, [])

  async function handleSetPlaybackBuffer(preset: string) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.playback-buffer', () => api.settings.setPlaybackBuffer(preset))
  }

  async function handleSetAutoSubtitles(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.auto-subtitles', () => api.settings.setAutoSubtitles(enabled))
  }

  async function handleSetSubtitleLanguage(language: string) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.subtitle-language', () =>
        api.settings.setSubtitleLanguage(language)
      )
  }

  async function handleSetAudioLanguage(language: string) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.audio-language', () => api.settings.setAudioLanguage(language))
  }

  async function setStreamLimits(maxStreamResolution: number, maxStreamSizeGb: number) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.stream-limits', () =>
        api.settings.setStreamLimits({ maxStreamResolution, maxStreamSizeGb })
      )
  }

  async function runSpeedTest() {
    const api = window.api?.mediaHub
    if (!api) return
    setSpeedTest({ kind: 'busy' })
    try {
      const result = await api.network.speedTest(window.screen.height * window.devicePixelRatio)
      await api.settings.setStreamLimits({
        maxStreamResolution: result.recommendedResolution,
        maxStreamSizeGb: result.recommendedSizeGb,
        connectionSpeedMbps: result.speedMbps
      })
      await refreshMediaHubSettings()
      setSpeedTest({
        kind: 'ok',
        message: `${result.speedMbps} Mbps measured using ${formatBytes(result.testedBytes)}. Recommended limits applied; you can change them below.`,
        quality: result.recommendedResolution,
        size: result.recommendedSizeGb
      })
    } catch (error) {
      setSpeedTest({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not test this connection.'
      })
    }
  }

  // Columns tile left-to-right instead of stacking everything in one long
  // vertical scroll (see .tileArea/.column in Settings.module.css) — a
  // plain vertical mouse wheel has nothing to act on over .tileArea itself
  // (only overflow-x), so it's translated into horizontal panning UNLESS
  // the column under the cursor still has real vertical room to give it,
  // in which case that column's own native scroll wins instead. A native
  // listener, not React's onWheel: React attaches wheel handlers as passive
  // by default, and preventDefault on a passive listener is a silent no-op
  // (plus a console warning) — this needs to actually stop the page from
  // trying to rubber-band-scroll vertically instead.
  const tileAreaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = tileAreaRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (e.deltaY === 0) return
      const column = (e.target as HTMLElement).closest(`.${styles.column}`) as HTMLElement | null
      if (column) {
        const canScrollDown =
          e.deltaY > 0 && column.scrollTop + column.clientHeight < column.scrollHeight - 1
        const canScrollUp = e.deltaY < 0 && column.scrollTop > 0
        if (canScrollDown || canScrollUp) return
      }
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
        <div className={`${styles.column} ${styles.columnNarrow}`}>
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

          <section className={`${styles.section} glass-panel`} aria-labelledby="settings-subtitles">
            <h2 id="settings-subtitles" className={styles.sectionTitle}>
              Subtitles
            </h2>
            <ToggleRow
              icon="eye"
              title="Show subtitles automatically"
              description="Fetch and apply a matching subtitle as soon as a title starts playing."
              checked={mediaHubSettings?.autoSubtitlesEnabled ?? true}
              onChange={handleSetAutoSubtitles}
            />
            <SegmentedRow
              icon="planet"
              title="Subtitle language"
              description="Language to search for, both automatically and in the Subtitles menu."
              value={mediaHubSettings?.subtitleLanguage ?? 'en'}
              options={SUBTITLE_LANGUAGE_OPTIONS}
              onChange={handleSetSubtitleLanguage}
            />
            {/* Separate from the subtitle language directly above, because
                they genuinely differ for a lot of viewing — Japanese audio
                with English subtitles is the normal way to watch most of
                what's in the Anime section. */}
            <SegmentedRow
              icon="waveform"
              title="Audio language"
              description="Preferred spoken language. Used to pick the audio track when a release has several, and to avoid dubbed releases when an original-language one exists."
              value={mediaHubSettings?.audioLanguage ?? 'en'}
              options={SUBTITLE_LANGUAGE_OPTIONS}
              onChange={handleSetAudioLanguage}
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
            <SegmentedRow
              icon="display"
              title="Maximum video quality"
              description={`Avoid releases sharper than this display needs.${speedTest.quality ? ` ${speedTest.quality}p recommended by the last test.` : ''}`}
              value={String(mediaHubSettings?.maxStreamResolution ?? 0)}
              options={QUALITY_OPTIONS}
              onChange={(value) =>
                setStreamLimits(Number(value), mediaHubSettings?.maxStreamSizeGb ?? 0)
              }
            />
            <SegmentedRow
              icon="download"
              title="Maximum download size"
              description={`Prefer releases at or below this size.${speedTest.size ? ` ${speedTest.size} GB recommended by the last test.` : ''}`}
              value={String(mediaHubSettings?.maxStreamSizeGb ?? 0)}
              options={SIZE_OPTIONS}
              onChange={(value) =>
                setStreamLimits(mediaHubSettings?.maxStreamResolution ?? 0, Number(value))
              }
            />
            <div className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                <Icon name="gauge" size={17} />
              </div>
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>Connection recommendation</span>
                <span className={styles.rowDescription}>
                  Runs only when requested and downloads about 1 MB. It considers this screen and
                  saves suggested limits without locking them.
                </span>
              </div>
              <button
                type="button"
                className={styles.testButton}
                disabled={speedTest.kind === 'busy'}
                onClick={runSpeedTest}
              >
                {speedTest.kind === 'busy' ? 'Testing…' : mediaHubSettings?.connectionSpeedMbps ? 'Retest' : 'Run test'}
              </button>
            </div>
            {(speedTest.message || mediaHubSettings?.connectionSpeedMbps) && (
              <span className={`${styles.statusMessage} ${speedTest.kind === 'error' ? styles.statusError : styles.statusOk}`}>
                {speedTest.message || `Last result: ${mediaHubSettings?.connectionSpeedMbps} Mbps.`}
              </span>
            )}
            <div className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                <Icon name="net" size={17} />
              </div>
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>Local network address</span>
                <span className={styles.rowDescription}>
                  What Watch Party shares on your LAN when hosting directly.
                </span>
              </div>
              <span className={styles.rowValue}>{networkInfo?.lanIp ?? '—'}</span>
            </div>
          </section>
        </div>

        <div className={`${styles.column} ${styles.columnWide}`}>
          <MediaServicesSection />
        </div>

        <div className={`${styles.column} ${styles.columnMedium}`}>
          <TorBoxSection />
          <TmdbSection />
          <OmdbSection />
          <SimklSection />
          <MalSection />
          <OpenSubtitlesSection />
          <MoreOptionsSection />
        </div>

        <div className={`${styles.column} ${styles.columnStrong}`}>
          <WatchPartySection />
          <R3PartySyncSection />

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
              Watch history is currently shared across all profiles — per-profile history is not
              built yet.
            </p>

            {editingProfile && (
              <ProfileForm
                target={
                  editingProfile === 'new'
                    ? null
                    : profiles.find((p) => p.id === editingProfile) || null
                }
                activeProfileId={activeProfileId}
                profileCount={profiles.length}
                onClose={() => setEditingProfile(null)}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
