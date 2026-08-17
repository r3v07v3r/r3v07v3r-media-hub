import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  SubDLSection,
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
// Floor matches streamCache.ts's own MIN_CACHE_BYTES (1.5GB, enforced
// server-side regardless of what's picked here) — 2GB is the smallest
// preset actually offered, comfortably above that floor. 0 = unbounded/
// drive-limited (still subject to a free-space safety margin), not "off" —
// the cache always runs, this only bounds how much disk it can use.
const STREAM_CACHE_SIZE_OPTIONS = [
  { value: '2', label: '2 GB' },
  { value: '5', label: '5 GB' },
  { value: '10', label: '10 GB' },
  { value: '20', label: '20 GB' },
  { value: '50', label: '50 GB' },
  { value: '0', label: 'Unlimited' }
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

/**
 * Like SegmentedRow, but for a value that isn't limited to a fixed preset
 * list — the presets are quick-picks (highlighted when the current value
 * matches one exactly), and the number field next to them accepts any
 * non-negative integer GB directly (3, 12, 15, whatever). Committed on
 * blur/Enter, not on every keystroke, so a half-typed value never fires a
 * settings write.
 */
function CacheSizeRow({
  icon,
  title,
  description,
  valueGb,
  presets,
  onChange
}: {
  icon: string
  title: string
  description: string
  valueGb: number
  presets: { value: string; label: string }[]
  onChange: (gb: number) => void
}) {
  const [draft, setDraft] = useState(String(valueGb))
  // React's own "adjusting state when a prop changes" pattern — updated
  // DURING render (not in an effect, which would cost an extra render
  // pass) whenever valueGb genuinely changes from elsewhere (a preset
  // click, another window, settings reload). Not while the person is
  // actively typing: prevValueGb only moves when valueGb itself does, so
  // an in-progress, not-yet-committed keystroke is never overwritten.
  const [prevValueGb, setPrevValueGb] = useState(valueGb)
  if (valueGb !== prevValueGb) {
    setPrevValueGb(valueGb)
    setDraft(String(valueGb))
  }

  function commitDraft(): void {
    // Number('') is 0, not NaN — an abandoned edit (cleared the field,
    // clicked away) would otherwise silently commit as "unbounded", not
    // get rejected and restored like any other invalid input.
    const trimmed = draft.trim()
    const parsed = trimmed === '' ? NaN : Math.round(Number(trimmed))
    if (Number.isFinite(parsed) && parsed >= 0 && String(parsed) !== String(valueGb)) {
      onChange(parsed)
    } else {
      setDraft(String(valueGb))
    }
  }

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
        {presets.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={String(valueGb) === option.value}
            className={`${styles.segmentButton} ${String(valueGb) === option.value ? styles.segmentButtonActive : ''}`}
            onClick={() => onChange(Number(option.value))}
          >
            {option.label}
          </button>
        ))}
        <span className={styles.field} style={{ flex: '0 0 88px' }}>
          <input
            className={styles.fieldInput}
            style={{ padding: '5px 10px', fontSize: 12, textAlign: 'right' }}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            aria-label={`Custom ${title} in GB`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </span>
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

/**
 * Sizes one settings category's .groupGrid/.settingsGroup pair to exactly
 * fit however many columns its cards actually pack into.
 *
 * .groupGrid is `display:flex; flex-flow:column wrap` (see
 * Settings.module.css) so each column fills independently from its own
 * content — no shared row tracks, no gap under a short card sitting next
 * to a tall one. But flex-wrap's column count is inherently "however many
 * fit in the available width," and .settingsGroup is a scroll container
 * (overflow-y: auto — needed so an oversized category scrolls internally
 * instead of blowing out the page). Per the CSS Sizing spec, a scroll
 * container's intrinsic size (width:auto, or explicit max-content) is its
 * own specified size, not whatever its content needs — that's the entire
 * point of overflow:auto. Left alone, extra columns don't widen the
 * category; they get silently clipped and trapped in a nested horizontal
 * scrollbar next to the outer shelf's own scroll, invisible unless you go
 * looking (caught in PR review on the change that introduced this
 * masonry layout, confirmed live: "Media services" and "Accounts" both
 * needed 3 columns and got capped at .settingsGroup's 780px min-width
 * instead, hiding the rest of their cards off the right edge). A CSS
 * multi-column layout (column-width) was tried first and hits the exact
 * same wall for the exact same reason.
 *
 * A literal pixel width isn't an intrinsic-sizing keyword, so it isn't
 * subject to that rule. This measures the real column-packed layout
 * (briefly unconstrained by width, so flex-wrap finds its natural column
 * count from the category's available height alone) and locks the result
 * in as an explicit width on both the grid and its containing category —
 * all inside useLayoutEffect, so the oversized scratch state it passes
 * through is never painted.
 */
function useColumnPackGrid<TGroup extends HTMLElement = HTMLElement>() {
  const gridRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<TGroup>(null)

  useLayoutEffect(() => {
    const grid = gridRef.current
    const group = groupRef.current
    if (!grid || !group) return

    function pack(): void {
      const grid = gridRef.current
      const group = groupRef.current
      if (!grid || !group) return
      const cards = Array.from(grid.children) as HTMLElement[]
      if (!cards.length) return
      // Scratch width: comfortably more than any real category could need,
      // so every card lands in whatever column its height naturally puts
      // it in, unclipped.
      grid.style.width = `${Math.max(4000, cards.length * 500)}px`
      const gridLeft = grid.getBoundingClientRect().left
      const tight = Math.ceil(
        Math.max(...cards.map((c) => c.getBoundingClientRect().right)) - gridLeft
      )
      grid.style.width = `${tight}px`
      // +12: .settingsGroup's own padding-right (6px) plus a little slop
      // for the scrollbar overflow-y:auto can introduce.
      group.style.width = `${tight + 12}px`
    }

    pack()
    window.addEventListener('resize', pack)
    const observer = new MutationObserver(pack)
    observer.observe(grid, { childList: true })
    return () => {
      window.removeEventListener('resize', pack)
      observer.disconnect()
    }
  }, [])

  return { gridRef, groupRef }
}

export default function SettingsPage() {
  const tileAreaRef = useRef<HTMLDivElement>(null)
  const generalPack = useColumnPackGrid<HTMLElement>()
  const playbackPack = useColumnPackGrid<HTMLElement>()
  const servicesPack = useColumnPackGrid<HTMLElement>()
  const accountsPack = useColumnPackGrid<HTMLElement>()
  const communityPack = useColumnPackGrid<HTMLElement>()
  const {
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
  const [streamCacheDirStatus, setStreamCacheDirStatus] = useState<{
    kind: 'idle' | 'busy' | 'error'
    message?: string
  }>({ kind: 'idle' })
  const [streamCacheClearStatus, setStreamCacheClearStatus] = useState<{
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

  useEffect(() => {
    window.api?.mediaHub?.network
      .info()
      .then(setNetworkInfo)
      .catch(() => {})
  }, [])

  async function handleTogglePerformancePanel(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.performance-panel', () =>
        api.settings.setPerformancePanelVisible(enabled)
      )
  }

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

  async function setStreamCacheSize(streamCacheMaxGb: number) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.stream-cache-size', () =>
        api.settings.setStreamCacheSize(streamCacheMaxGb)
      )
  }

  async function handleChooseStreamCacheDir() {
    const api = window.api?.mediaHub?.settings
    if (!api) return
    setStreamCacheDirStatus({ kind: 'busy' })
    try {
      const result = await api.chooseStreamCacheDir()
      if (result.error) {
        setStreamCacheDirStatus({ kind: 'error', message: result.error })
        return
      }
      // A cancelled picker isn't an error — just nothing to report.
      setStreamCacheDirStatus({ kind: 'idle' })
      if (!result.cancelled) await refreshMediaHubSettings()
    } catch (error) {
      setStreamCacheDirStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not change the folder.'
      })
    }
  }

  async function handleResetStreamCacheDir() {
    const api = window.api?.mediaHub?.settings
    if (!api) return
    setStreamCacheDirStatus({ kind: 'busy' })
    try {
      await api.resetStreamCacheDir()
      setStreamCacheDirStatus({ kind: 'idle' })
      await refreshMediaHubSettings()
    } catch (error) {
      // Own try/catch (not the generic saveSetting wrapper) so a specific
      // refusal — e.g. "stop playback first" — reaches the person instead
      // of saveSetting's fixed "Couldn't save that setting." Mirrors
      // handleChooseStreamCacheDir's own handling just above.
      setStreamCacheDirStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not reset the folder.'
      })
    }
  }

  async function handleClearStreamCache() {
    const api = window.api?.mediaHub?.playback
    if (!api) return
    setStreamCacheClearStatus({ kind: 'busy' })
    try {
      const result = await api.clearStreamCache()
      setStreamCacheClearStatus({ kind: 'ok', message: `Freed ${formatBytes(result.freedBytes)}.` })
    } catch (error) {
      setStreamCacheClearStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not clear the cache.'
      })
    }
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

  useEffect(() => {
    const scroller = tileAreaRef.current
    if (!scroller) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      const group = (event.target as HTMLElement).closest(
        `.${styles.settingsGroup}`
      ) as HTMLElement | null
      if (group) {
        const canScrollDown =
          event.deltaY > 0 && group.scrollTop + group.clientHeight < group.scrollHeight - 1
        const canScrollUp = event.deltaY < 0 && group.scrollTop > 0
        if (canScrollDown || canScrollUp) return
      }
      event.preventDefault()
      scroller.scrollBy({ left: event.deltaY, behavior: 'auto' })
    }

    scroller.addEventListener('wheel', handleWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <div className={styles.wrap}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heading}>Settings</h1>
          <p className={styles.headingDescription}>
            Manage playback, services, and your R3 experience.
          </p>
        </div>
        <nav className={styles.categoryNav} aria-label="Settings categories">
          {[
            ['settings-general', 'General'],
            ['settings-playback', 'Playback'],
            ['settings-services', 'Services'],
            ['settings-accounts', 'Accounts'],
            ['settings-community', 'Community']
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className={styles.tileArea} ref={tileAreaRef}>
        <section
          id="settings-general"
          ref={generalPack.groupRef}
          className={styles.settingsGroup}
          aria-labelledby="settings-general-title"
        >
          <header className={styles.groupHeader}>
            <span className={styles.groupEyebrow}>Essentials</span>
            <h2 id="settings-general-title">General</h2>
            <p>App updates, display preferences, and everyday behavior.</p>
          </header>
          <div ref={generalPack.gridRef} className={styles.groupGrid}>
            <AboutUpdateSection />

            <section className={`${styles.section} glass-panel`} aria-labelledby="settings-perf">
              <h2 id="settings-perf" className={styles.sectionTitle}>
                Performance &amp; Display
              </h2>
              <ToggleRow
                icon="cpu"
                title="System performance panel"
                description="Show live CPU, GPU, RAM, and network gauges on the Home dashboard."
                checked={mediaHubSettings?.performancePanelVisible ?? true}
                onChange={handleTogglePerformancePanel}
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

            <MoreOptionsSection />
          </div>
        </section>

        <section
          id="settings-playback"
          ref={playbackPack.groupRef}
          className={styles.settingsGroup}
          aria-labelledby="settings-playback-title"
        >
          <header className={styles.groupHeader}>
            <span className={styles.groupEyebrow}>Watching</span>
            <h2 id="settings-playback-title">Playback</h2>
            <p>Choose language, quality, and connection preferences.</p>
          </header>
          <div ref={playbackPack.gridRef} className={styles.groupGrid}>
            <section
              className={`${styles.section} glass-panel`}
              aria-labelledby="settings-subtitles"
            >
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
              <CacheSizeRow
                icon="downloads"
                title="Stream cache size"
                description="How much local disk playback can use to buffer ahead and rewind without reopening a connection to the source. Larger also enables extracting embedded subtitle tracks, which needs the whole file cached. Pick a preset or type your own value in GB."
                valueGb={mediaHubSettings?.streamCacheMaxGb ?? 10}
                presets={STREAM_CACHE_SIZE_OPTIONS}
                onChange={setStreamCacheSize}
              />
              <div className={styles.row}>
                <div className={styles.rowIcon} aria-hidden="true">
                  <Icon name="downloads" size={17} />
                </div>
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>Stream cache location</span>
                  <span className={styles.rowDescription}>
                    {mediaHubSettings?.streamCacheDir || 'Default (app data folder)'} — useful for
                    pointing it at a secondary drive. Changing this does not move data already
                    cached at the old location.
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.testButton}
                  onClick={handleChooseStreamCacheDir}
                  disabled={streamCacheDirStatus.kind === 'busy'}
                >
                  {streamCacheDirStatus.kind === 'busy' ? 'Choosing…' : 'Choose folder…'}
                </button>
                {mediaHubSettings?.streamCacheDir && (
                  <button
                    type="button"
                    className={styles.testButton}
                    onClick={handleResetStreamCacheDir}
                  >
                    Reset to default
                  </button>
                )}
              </div>
              {streamCacheDirStatus.kind === 'error' && (
                <span className={`${styles.statusMessage} ${styles.statusError}`}>
                  {streamCacheDirStatus.message}
                </span>
              )}
              <div className={styles.row}>
                <div className={styles.rowIcon} aria-hidden="true">
                  <Icon name="trash" size={17} />
                </div>
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>Stream cache</span>
                  <span className={styles.rowDescription}>
                    Buffered video data kept on disk for smooth seeking. Whatever is actively
                    playing right now is never cleared.
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.testButton}
                  onClick={handleClearStreamCache}
                  disabled={streamCacheClearStatus.kind === 'busy'}
                >
                  {streamCacheClearStatus.kind === 'busy' ? 'Clearing…' : 'Clear cache'}
                </button>
              </div>
              {streamCacheClearStatus.kind !== 'idle' && streamCacheClearStatus.kind !== 'busy' && (
                <span
                  className={`${styles.statusMessage} ${streamCacheClearStatus.kind === 'ok' ? styles.statusOk : styles.statusError}`}
                >
                  {streamCacheClearStatus.message}
                </span>
              )}
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
                  {speedTest.kind === 'busy'
                    ? 'Testing…'
                    : mediaHubSettings?.connectionSpeedMbps
                      ? 'Retest'
                      : 'Run test'}
                </button>
              </div>
              {(speedTest.message || mediaHubSettings?.connectionSpeedMbps) && (
                <span
                  className={`${styles.statusMessage} ${speedTest.kind === 'error' ? styles.statusError : styles.statusOk}`}
                >
                  {speedTest.message ||
                    `Last result: ${mediaHubSettings?.connectionSpeedMbps} Mbps.`}
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
        </section>

        <section
          id="settings-services"
          ref={servicesPack.groupRef}
          className={styles.settingsGroup}
          aria-labelledby="settings-services-title"
        >
          <header className={styles.groupHeader}>
            <span className={styles.groupEyebrow}>Library</span>
            <h2 id="settings-services-title">Media services</h2>
            <p>Connect servers, download clients, and your streaming provider.</p>
          </header>
          <div ref={servicesPack.gridRef} className={`${styles.groupGrid} ${styles.groupGridWide}`}>
            <MediaServicesSection />
            <TorBoxSection />
          </div>
        </section>

        <section
          id="settings-accounts"
          ref={accountsPack.groupRef}
          className={styles.settingsGroup}
          aria-labelledby="settings-accounts-title"
        >
          <header className={styles.groupHeader}>
            <span className={styles.groupEyebrow}>Connections</span>
            <h2 id="settings-accounts-title">Accounts &amp; metadata</h2>
            <p>Link discovery, tracking, artwork, and subtitle providers.</p>
          </header>
          <div ref={accountsPack.gridRef} className={styles.groupGrid}>
            <TmdbSection />
            <OmdbSection />
            <SimklSection />
            <MalSection />
            <SubDLSection />
            <OpenSubtitlesSection />
          </div>
        </section>

        <section
          id="settings-community"
          ref={communityPack.groupRef}
          className={styles.settingsGroup}
          aria-labelledby="settings-community-title"
        >
          <header className={styles.groupHeader}>
            <span className={styles.groupEyebrow}>People</span>
            <h2 id="settings-community-title">Community &amp; profiles</h2>
            <p>Set up shared viewing and choose who is watching.</p>
          </header>
          <div ref={communityPack.gridRef} className={styles.groupGrid}>
            <WatchPartySection />
            <R3PartySyncSection />

            <section
              className={`${styles.section} glass-panel`}
              aria-labelledby="settings-profiles"
            >
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
        </section>
      </div>
    </div>
  )
}
