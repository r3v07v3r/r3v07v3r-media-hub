import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useAsyncAction } from '@renderer/hooks/useAsyncAction'
import { AboutUpdateSection } from './AboutUpdateSection'
import { LanCacheSection } from './LanCacheSection'
import { MediaServicesSection } from './MediaServicesSection'
import {
  TorBoxSection,
  TmdbSection,
  OmdbSection,
  SimklSection,
  TraktSection,
  MalSection,
  SubDLSection,
  OllamaSection,
  OpenSubtitlesSection,
  R3PartySyncSection
} from './MediaHubSettingsSections'
import type {
  CacheMode,
  NetworkInfoResult,
  ProfilePublic,
  SourcePreference
} from '@shared/media-hub/types'
import styles from './Settings.module.css'
import { WatchlistSyncSection } from '@renderer/components/settings/WatchlistSyncSection'

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

// Three plain choices rather than mpv's ~40 scaler names: the difference
// between neighbouring high-end filters is invisible in motion, the difference
// between cheap and good is not. See shared/media-hub/videoScaling.ts.
const VIDEO_SCALING_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Standard' },
  { value: 'high', label: 'High' },
  { value: 'sharp', label: 'Sharp' }
]

const QUALITY_OPTIONS = [
  { value: '0', label: 'Any' },
  { value: '480', label: '480p' },
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: '1440', label: '1440p' },
  { value: '2160', label: '4K' }
]
const SOURCE_PREFERENCE_OPTIONS = [
  { value: 'prefer-local', label: 'Media server' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'prefer-quality', label: 'Best quality' }
]
const CACHE_MODE_OPTIONS = [
  { value: 'disk', label: 'Cache to disk' },
  { value: 'memory', label: 'Memory only' }
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

/**
 * An ordered setting as a slider rather than a row of pills.
 *
 * Six of this page's option sets are SCALES — video quality, download size,
 * stream cache size, playback buffer, video scaling, and the media-server-to-
 * best-quality preference. Rendering a scale as six equal buttons throws away
 * the one thing that matters about it: that the options have an order, and
 * that "more" lies in a direction. It also costs the most horizontal room of
 * anything on the page, which is what pushed controls to the far edge of
 * their cards.
 *
 * A slider says both at once — where you are, and which way is more.
 *
 * Built on a real <input type="range"> rather than a custom-drawn track,
 * because that brings the whole keyboard model with it: arrows step, Home and
 * End jump to the ends, Page Up/Down move by more, and every screen reader
 * already knows what it is. The one thing it does not know is that this scale
 * is not numeric, which is what aria-valuetext is for — it reads "1080p",
 * never "3 of 6".
 *
 * The slider carries the INDEX, not the value: these scales are ordered but
 * not evenly spaced (480, 720, 1080, 1440, 2160) and some are not numbers at
 * all ("Unlimited" is the top of the cache scale and the value 0). Index is
 * the only thing that is genuinely linear.
 */
function SliderRow({
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
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const current = options[index] ?? options[0]
  // 0 and 100 would put the fill under the thumb's own radius at the ends.
  const percent = options.length > 1 ? (index / (options.length - 1)) * 100 : 0

  return (
    <div className={`${styles.row} ${styles.rowSlider}`}>
      <div className={styles.rowIcon} aria-hidden="true">
        <Icon name={icon} size={17} />
      </div>
      <div className={styles.rowText}>
        <div className={styles.sliderHead}>
          <span className={styles.rowTitle}>{title}</span>
          {/* The value belongs beside the title, not under the thumb: it is
              the answer to "what is this set to", and it should not move. */}
          <span className={styles.sliderValue}>{current.label}</span>
        </div>
        <span className={styles.rowDescription}>{description}</span>
        <input
          type="range"
          className={styles.slider}
          min={0}
          max={options.length - 1}
          step={1}
          value={index}
          aria-label={title}
          aria-valuetext={current.label}
          style={{ ['--fill' as string]: `${percent}%` }}
          onChange={(event) => {
            const next = options[Number(event.target.value)]
            if (next && next.value !== value) onChange(next.value)
          }}
        />
        {/* EVERY STOP IS LABELLED, and the one in effect is marked.
            Labelling only the ends said which way was "more" and left you
            counting notches to work out where the thumb had landed — the
            value named above told you what it WAS, but not where it sat on
            the scale, or what the next step along would be. */}
        <div className={styles.sliderScale} aria-hidden="true">
          {options.map((option, i) => (
            <span
              key={option.value}
              className={i === index ? styles.sliderStopActive : styles.sliderStop}
            >
              {option.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

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
  /** 0 is "unlimited", and a field showing 0 next to a highlighted
   *  "Unlimited" preset reads as a contradiction. Blank, with the word as
   *  the placeholder, says the same thing once. */
  const asDraft = (gb: number): string => (gb === 0 ? '' : String(gb))
  const [draft, setDraft] = useState(asDraft(valueGb))
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
      </div>
      {/* OUT of the preset pill, and labelled.

          It used to be an unlabelled number box inside the pill, which
          wrapped onto a second line of its own and read as a stray "0"
          sitting under the presets — worse still, that 0 IS unlimited, so it
          appeared to contradict the highlighted Unlimited beside it.

          Shown empty when unlimited, with the word as its placeholder, so
          the field and the pill always say the same thing. */}
      <label className={styles.cacheCustom}>
        <span className={styles.cacheCustomLabel}>Or set your own</span>
        <input
          className={styles.fieldInput}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="Unlimited"
          aria-label={`Custom ${title} in GB`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <span className={styles.cacheCustomUnit}>GB</span>
      </label>
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

/** A row whose control is a button rather than a switch or a segment — used
 *  where the setting is an action taken now (export a file, restore one)
 *  rather than a value that persists. */
function ActionRow({
  icon,
  title,
  description,
  label,
  busy,
  onClick
}: {
  icon: string
  title: string
  description: string
  label: string
  busy?: boolean
  onClick: () => void
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
      <button type="button" className={styles.testButton} disabled={busy} onClick={onClick}>
        {busy ? 'Working…' : label}
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
function MoreOptionsSection({
  quick = false,
  heading = 'More Options',
  hint
}: {
  /** On the viewer's short page: the browsing and motion toggles, without
   *  the subtitle-cache maintenance row, which is a housekeeping action
   *  rather than something you set while watching. */
  quick?: boolean
  heading?: string
  /** One line under the heading saying what the card is FOR. Only the
   *  viewer's page passes one; inside the control centre the rail entry and
   *  the group header already say it. */
  hint?: string
} = {}) {
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
    <section
      className={`${styles.section} ${quick ? styles.quickCard : ''} glass-panel`}
      aria-labelledby="settings-more"
    >
      <header className={styles.quickCardHead}>
        <h2 id="settings-more" className={styles.sectionTitle}>
          {heading}
        </h2>
        {hint && <p className={styles.quickCardHint}>{hint}</p>}
      </header>
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
      {!quick && (
        <>
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
        </>
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
/**
 * Measures each category's cards and pins an explicit pixel width on the
 * grid and its group, so the filmstrip's `flex-flow: column wrap` packs
 * into columns without clipping.
 *
 * `enabled` exists because the control centre face does NOT want this. It
 * lays the same cards out as a responsive CSS grid, and an inline pixel
 * width beats any stylesheet — which is exactly what went wrong: the packer
 * pinned one group at 1458px inside a 1160px parent, and the rest at 340px,
 * so five of the six categories collapsed to a single column while the
 * first overflowed. The symptom looked like a grid bug and was not one.
 *
 * When disabled it also CLEARS any width it previously set, so toggling
 * between the two layouts cannot leave a stale measurement behind.
 */
function useColumnPackGrid<TGroup extends HTMLElement = HTMLElement>(enabled = true) {
  const gridRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<TGroup>(null)
  const gridBinding = useCallback((node: HTMLDivElement | null) => {
    gridRef.current = node
  }, [])
  const groupBinding = useCallback((node: TGroup | null) => {
    groupRef.current = node
  }, [])

  useLayoutEffect(() => {
    const grid = gridRef.current
    const group = groupRef.current
    if (!grid || !group) return
    if (!enabled) {
      grid.style.width = ''
      group.style.width = ''
      return
    }

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
  }, [enabled])

  return [gridBinding, groupBinding] as const
}

/**
 * `embedded` is set when this is hosted inside the control centre rather
 * than rendered as the /settings route. It only suppresses the page-level
 * heading — every control below behaves identically, which is the point:
 * the sections were re-homed, not rewritten.
 */
/** The category ids this page is divided into — the same list the control
 *  centre's rail uses to give each one its own entry. */
export type SettingsCategory = 'general' | 'playback' | 'services' | 'accounts' | 'ai' | 'community'

export default function SettingsPage({
  embedded = false,
  category
}: { embedded?: boolean; category?: SettingsCategory } = {}) {
  const tileAreaRef = useRef<HTMLDivElement>(null)
  /** With no category asked for, every group renders — the standalone
   *  /settings route, unchanged. With one, only that group does, which is
   *  what lets the control centre give each its own rail entry instead of a
   *  strip of tabs above one long scroll. */
  const shows = (id: SettingsCategory): boolean => !category || category === id

  const [generalGridBinding, generalGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  const [playbackGridBinding, playbackGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  const [servicesGridBinding, servicesGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  // No grid binding for Accounts: it is three smaller grids now, not one,
  // and the packer sizes a single grid against its group. The group
  // binding stays, since the group is still one scroll container.
  const [, accountsGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  const [communityGridBinding, communityGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  const [aiGridBinding, aiGroupBinding] = useColumnPackGrid<HTMLElement>(!embedded)
  const {
    setControlCentreOpen,
    profiles,
    activeProfileId,
    switchProfile,
    mediaHubSettings,
    refreshMediaHubSettings,
    pushNotification,
    refreshWatchStatus,
    refreshProfiles,
    reloadLibrary
  } = useAppState()
  // null = no form open, 'new' = create form, otherwise the id of the
  // profile being edited.
  const [editingProfile, setEditingProfile] = useState<string | 'new' | null>(null)
  // Which of the two backup actions is in flight, so only that button says so.
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | 'imdb' | 'letterboxd' | null>(
    null
  )
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

  async function handleSetVideoScaling(preset: string) {
    const api = window.api?.mediaHub
    if (api) await saveSetting('settings.video-scaling', () => api.settings.setVideoScaling(preset))
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

  async function handleExportBackup() {
    const api = window.api?.mediaHub
    if (!api) return
    setBackupBusy('export')
    try {
      const result = await api.settings.exportBackup()
      // A cancelled picker is not a failure and gets no message — the person
      // closed the dialog, they know what happened.
      if (result?.filePath) {
        pushNotification({ tone: 'success', message: 'Backup saved.' })
      }
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'The backup could not be saved.'
      })
    } finally {
      setBackupBusy(null)
    }
  }

  async function handleImportBackup() {
    const api = window.api?.mediaHub
    if (!api) return
    setBackupBusy('import')
    try {
      const result = await api.settings.importBackup()
      if (!result) return
      const taken = result.createdAt ? new Date(result.createdAt).toLocaleDateString() : null
      pushNotification({
        tone: 'success',
        message: taken
          ? `Restored ${result.restored} items from your ${taken} backup.`
          : `Restored ${result.restored} items.`
      })
      // Everything on screen was read from the library this just replaced —
      // including the PROFILE LIST, whose ids differ from this machine's
      // whenever the backup came from another one. Without that refresh the
      // restored rows belong to profiles missing from the switcher, and the
      // still-active local profile looks empty until the app is restarted.
      await refreshMediaHubSettings()
      // Profiles BEFORE the library reload: main has already switched the
      // active profile to whoever the backup was taken by, and the renderer
      // has to learn both the new list and which of them is current before
      // anything re-reads against it.
      refreshProfiles()
      // Bumps the library key every profile-scoped read depends on. The
      // profile id cannot carry this on its own: a same-profile restore leaves
      // it identical while replacing every row under it.
      reloadLibrary()
      refreshWatchStatus()
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'That backup could not be restored.'
      })
    } finally {
      setBackupBusy(null)
    }
  }

  async function handleImportImdbRatings() {
    const api = window.api?.mediaHub
    if (!api) return
    setBackupBusy('imdb')
    try {
      const result = await api.settings.importImdbRatings()
      // A cancelled picker, like the backup restore above.
      if (!result) return
      pushNotification({
        tone: 'success',
        message:
          result.ratings || result.skipped
            ? `Added ${result.ratings} ${result.ratings === 1 ? 'rating' : 'ratings'}.${
                result.skipped ? ` ${result.skipped} rows could not be read.` : ''
              }`
            : 'Everything in that file was already here.'
      })
      // A rating changes what the ranking should suggest — see the same
      // reload after a Trakt import.
      reloadLibrary()
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'That file could not be read.'
      })
    } finally {
      setBackupBusy(null)
    }
  }

  async function handleImportLetterboxd() {
    const api = window.api?.mediaHub
    if (!api) return
    setBackupBusy('letterboxd')
    try {
      const result = await api.settings.importLetterboxd()
      // A cancelled picker, like the two imports above.
      if (!result) return
      pushNotification({
        tone: 'success',
        message:
          result.plays || result.ratings
            ? `Added ${result.plays} ${result.plays === 1 ? 'viewing' : 'viewings'} and ${result.ratings} ${result.ratings === 1 ? 'rating' : 'ratings'}.${
                result.skipped ? ` ${result.skipped} rows could not be matched.` : ''
              }`
            : 'Everything in that export was already here.'
      })
      reloadLibrary()
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'That export could not be read.'
      })
    } finally {
      setBackupBusy(null)
    }
  }

  async function handleSetNotifications(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.notifications', () => api.settings.setNotifications(enabled))
  }

  async function handleSetWatchRegion(region: string) {
    const api = window.api?.mediaHub
    if (api) await saveSetting('settings.watch-region', () => api.settings.setWatchRegion(region))
  }

  async function handleSetAutoplayNext(enabled: boolean) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.autoplay-next', () => api.settings.setAutoplayNext(enabled))
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

  async function setSourcePreference(sourcePreference: SourcePreference) {
    const api = window.api?.mediaHub
    if (api)
      await saveSetting('settings.source-preference', () =>
        api.settings.setSourcePreference(sourcePreference)
      )
  }

  async function setStoreMedia(storeMedia: boolean) {
    const api = window.api?.mediaHub
    if (api) await saveSetting('settings.store-media', () => api.settings.setStoreMedia(storeMedia))
  }

  async function setCacheMode(cacheMode: CacheMode) {
    const api = window.api?.mediaHub
    if (api) await saveSetting('settings.cache-mode', () => api.settings.setCacheMode(cacheMode))
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

  // THE VIEWER'S PAGE IS SHORT NOW.
  //
  // Everything below used to render here as well as in the control centre:
  // services, accounts, allocation, AI, backups, community. Two places for
  // one setting is two places to look and two places for them to disagree,
  // and none of it is what somebody reaches for mid-film. The control
  // centre is where the system is configured; this is the handful you
  // change while watching, and a way through to the rest.
  if (!embedded && !category) {
    return (
      <div className={`${styles.wrap} ${styles.quickWrap}`}>
        <div className={`${styles.pageHeader} ${styles.quickHeader}`}>
          <div>
            <span className={styles.quickEyebrow}>Your player</span>
            <h1 className={styles.heading}>Settings</h1>
            <p className={styles.headingDescription}>
              The things you change while watching. Everything else lives in the control centre.
            </p>
          </div>
          {/* The way through, in the header where a page's primary action
              belongs, rather than only as a slab at the bottom of a scroll
              nobody reaches. */}
          <button
            type="button"
            className={styles.quickJump}
            onClick={() => setControlCentreOpen(true)}
          >
            <Icon name="settings" size={15} />
            Control centre
          </button>
        </div>

        {/* Scrolls on its own so the header stays put, and lays the cards out
            in columns instead of stretching every row the width of the
            window — a 1200px-wide switch row with its label at one end and
            its control at the other is a line to track, not a setting. */}
        <div className={styles.quickBody}>
          <div className={styles.quickGrid}>
            <section
              className={`${styles.section} ${styles.quickCard} glass-panel`}
              aria-labelledby="quick-playback"
            >
              <header className={styles.quickCardHead}>
                <h2 id="quick-playback" className={styles.sectionTitle}>
                  Playback
                </h2>
                <p className={styles.quickCardHint}>How a title starts, and in which languages.</p>
              </header>
              <ToggleRow
                icon="play"
                title="Play the next episode"
                description="When an episode ends, offer the next one and start it after a short countdown. Movies and last episodes are unaffected."
                checked={mediaHubSettings?.autoplayNextEnabled ?? true}
                onChange={handleSetAutoplayNext}
              />
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
              <SegmentedRow
                icon="waveform"
                title="Audio language"
                description="Preferred spoken language. Used to pick the audio track when a release has several, and to avoid dubbed releases when an original-language one exists."
                value={mediaHubSettings?.audioLanguage ?? 'en'}
                options={SUBTITLE_LANGUAGE_OPTIONS}
                onChange={handleSetAudioLanguage}
              />
            </section>

            <MoreOptionsSection
              quick
              heading="Browsing"
              hint="What the grids show you before you have filtered anything."
            />

            {/* Updates live here as well as in the control centre — the same
                card, driven by the same useUpdateManager, so the two cannot
                report different states. "Am I up to date, and what changed"
                is asked from wherever somebody happens to be; it is not worth
                crossing into the control centre for. */}
            <AboutUpdateSection />
          </div>

          {/* Not a list of what is through there — that would be this page
              again, in miniature, and would go stale the first time the
              control centre gained a section. */}
          <button
            type="button"
            className={styles.openControlCentre}
            onClick={() => setControlCentreOpen(true)}
          >
            <Icon name="settings" size={17} />
            <span>
              <b>Open the control centre</b>
              Services, accounts, storage, the cache server and the rest of the pipeline.
            </span>
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`${styles.wrap} ${embedded ? styles.embedded : ''}`}>
      {/* Both of its children are conditional, and inside the control
          centre with a category chosen BOTH are hidden — the heading
          because the rail supplies one, the strip because each group
          now has its own entry. What was left was an empty sticky bar
          with a dark gradient and 10px of padding: the line above every
          page title. Not rendered at all now rather than styled away. */}
      {(!embedded || !category) && (
        <div className={styles.pageHeader}>
          {/* Hidden when hosted inside the control centre, which supplies its
              own heading — two <h1>s describing the same content is a worse
              document outline, not just visual duplication. The category nav
              below stays either way: jumping between groups is more useful in
              the panel than it ever was on the page. */}
          {!embedded && (
            <div>
              <h1 className={styles.heading}>Settings</h1>
              <p className={styles.headingDescription}>
                Manage playback, services, and your R3 experience.
              </p>
            </div>
          )}
          {/* The strip is a way to jump between groups on one long page. With
              each group on its own rail entry there is nothing to jump
              between, and a second row of the same names would just be the
              navigation twice. */}
          {!category && (
            <nav className={styles.categoryNav} aria-label="Settings categories">
              {[
                ['settings-general', 'General'],
                ['settings-playback', 'Playback'],
                ['settings-services', 'Services'],
                ['settings-accounts', 'Accounts'],
                ['settings-ai', 'AI'],
                ['settings-community', 'Community']
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
                  }
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}

      <div className={styles.tileArea} ref={tileAreaRef}>
        {shows('general') && (
          <section
            id="settings-general"
            ref={generalGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-general-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>Essentials</span>
              <h2 id="settings-general-title">General</h2>
              {/* Not "app updates" any more — those have their own rail entry
                  (see controlcentre/sections.ts) rather than being the first
                  tile in here. */}
              <p>Display preferences, your library, and everyday behavior.</p>
            </header>
            <div ref={generalGridBinding} className={styles.groupGrid}>
              <section className={`${styles.section} glass-panel`} aria-labelledby="settings-perf">
                <h2 id="settings-perf" className={styles.sectionTitle}>
                  Performance &amp; Display
                </h2>
                <ToggleRow
                  icon="notification"
                  title="Notify me about new episodes"
                  description="A desktop notification when something in My List has a new episode out. Checked a few times a day, and never while you are watching something."
                  checked={mediaHubSettings?.notificationsEnabled ?? false}
                  onChange={handleSetNotifications}
                />
                <ToggleRow
                  icon="cpu"
                  title="System performance panel"
                  description="Show live CPU, GPU, RAM, and network gauges on the Home dashboard."
                  checked={mediaHubSettings?.performancePanelVisible ?? true}
                  onChange={handleTogglePerformancePanel}
                />
                <SliderRow
                  icon="clock"
                  title="Playback buffer"
                  description="How far ahead to keep loading while you watch. Higher settings ride out a slow or unstable connection and let you pause, let it fill, and resume without waiting — at the cost of more memory. Playback still starts straight away either way."
                  value={mediaHubSettings?.playbackBuffer ?? 'auto'}
                  options={PLAYBACK_BUFFER_OPTIONS}
                  onChange={handleSetPlaybackBuffer}
                />
                <SliderRow
                  icon="cpu"
                  title="Video scaling"
                  description="How video is resized to fit your screen, done on the GPU while playing. Standard leaves mpv's own scalers in place, which is the lightest on the GPU. Sharp is crisper on older, lower-resolution titles; it can ring slightly on very noisy sources, which is why it isn't the default."
                  value={mediaHubSettings?.videoScaling ?? 'auto'}
                  options={VIDEO_SCALING_OPTIONS}
                  onChange={handleSetVideoScaling}
                />
              </section>

              <section
                className={`${styles.section} glass-panel`}
                aria-labelledby="settings-backup"
              >
                <h2 id="settings-backup" className={styles.sectionTitle}>
                  Your library
                </h2>
                <ActionRow
                  icon="downloads"
                  title="Save a backup"
                  description="Writes every profile's list, history, ratings and resume points to one file. Service credentials are never included — they belong to this machine."
                  label="Save…"
                  busy={backupBusy === 'export'}
                  onClick={handleExportBackup}
                />
                <ActionRow
                  icon="refresh"
                  title="Restore a backup"
                  description="Puts your library back the way the backup file has it, and switches to the profile that was active when it was taken. Replaces what is here rather than merging, and nothing changes unless the whole restore succeeds."
                  label="Restore…"
                  busy={backupBusy === 'import'}
                  onClick={handleImportBackup}
                />
                <ActionRow
                  icon="star"
                  title="Import ratings from IMDb"
                  description="Reads the ratings.csv IMDb gives you from Your Ratings → Export. Matched by IMDb id, so nothing is guessed at — safe to run more than once, since a title already rated here keeps the score you gave it."
                  label="Import…"
                  busy={backupBusy === 'imdb'}
                  onClick={handleImportImdbRatings}
                />
                <ActionRow
                  icon="movies"
                  title="Import from Letterboxd"
                  description="Reads the diary and ratings from Letterboxd's Export Your Data (Settings → Data → Export). Needs TMDB connected above to match titles, and only imports one it can match exactly — this can take a few minutes for a large diary."
                  label="Import…"
                  busy={backupBusy === 'letterboxd'}
                  onClick={handleImportLetterboxd}
                />
              </section>

              <MoreOptionsSection />
            </div>
          </section>
        )}

        {shows('playback') && (
          <section
            id="settings-playback"
            ref={playbackGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-playback-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>Watching</span>
              <h2 id="settings-playback-title">Playback</h2>
              <p>Choose language, quality, and connection preferences.</p>
            </header>
            <div ref={playbackGridBinding} className={styles.groupGrid}>
              <section
                className={`${styles.section} glass-panel`}
                aria-labelledby="settings-episodes"
              >
                <h2 id="settings-episodes" className={styles.sectionTitle}>
                  Episodes
                </h2>
                {/* Two letters, typed rather than picked from a list: TMDB
                  answers for well over a hundred regions, and a dropdown of
                  all of them is a worse control than a field somebody fills in
                  once. An empty or malformed value clears the setting, which
                  puts it back on the machine's own locale. */}
                <div className={`${styles.row} ${styles.rowSegmented}`}>
                  <div className={styles.rowIcon} aria-hidden="true">
                    <Icon name="planet" size={17} />
                  </div>
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>Region for “Where to watch”</span>
                    <span className={styles.rowDescription}>
                      Two-letter country code. Streaming availability differs by country, so there
                      is no global answer. Leave it blank to follow this computer&apos;s own region.
                    </span>
                  </div>
                  <span className={styles.field} style={{ flex: '0 0 88px' }}>
                    <input
                      className={styles.fieldInput}
                      style={{ padding: '5px 10px', fontSize: 12, textAlign: 'center' }}
                      maxLength={2}
                      defaultValue={mediaHubSettings?.watchRegion ?? ''}
                      aria-label="Region for where to watch"
                      onBlur={(event) => void handleSetWatchRegion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                  </span>
                </div>
                <ToggleRow
                  icon="play"
                  title="Play the next episode"
                  description="When an episode ends, offer the next one and start it after a short countdown. Movies and last episodes are unaffected."
                  checked={mediaHubSettings?.autoplayNextEnabled ?? true}
                  onChange={handleSetAutoplayNext}
                />
              </section>

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

              <section
                className={`${styles.section} glass-panel`}
                aria-labelledby="settings-network"
              >
                <h2 id="settings-network" className={styles.sectionTitle}>
                  Network
                </h2>
                <SliderRow
                  icon="display"
                  title="Maximum video quality"
                  description={`Avoid releases sharper than this display needs.${speedTest.quality ? ` ${speedTest.quality}p recommended by the last test.` : ''}`}
                  value={String(mediaHubSettings?.maxStreamResolution ?? 0)}
                  options={QUALITY_OPTIONS}
                  onChange={(value) =>
                    setStreamLimits(Number(value), mediaHubSettings?.maxStreamSizeGb ?? 0)
                  }
                />
                <SliderRow
                  icon="download"
                  title="Maximum download size"
                  description={`Prefer releases at or below this size.${speedTest.size ? ` ${speedTest.size} GB recommended by the last test.` : ''}`}
                  value={String(mediaHubSettings?.maxStreamSizeGb ?? 0)}
                  options={SIZE_OPTIONS}
                  onChange={(value) =>
                    setStreamLimits(mediaHubSettings?.maxStreamResolution ?? 0, Number(value))
                  }
                />
                <SegmentedRow
                  icon="display"
                  title="Where to play from"
                  description="A media server on your own network starts instantly and costs no bandwidth. Balanced prefers it unless a noticeably better copy exists elsewhere; Media server prefers it whenever it has the title at all; Best quality ignores where a copy lives and picks the best one."
                  value={mediaHubSettings?.sourcePreference ?? 'balanced'}
                  options={SOURCE_PREFERENCE_OPTIONS}
                  onChange={(value) => setSourcePreference(value as SourcePreference)}
                />
                <div className={styles.row}>
                  <div className={styles.rowIcon} aria-hidden="true">
                    <Icon name="gauge" size={17} />
                  </div>
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>Connection recommendation</span>
                    <span className={styles.rowDescription}>
                      Runs only when requested. Downloads 1 MB, and keeps going only if that
                      finishes too fast to measure — a slow or metered connection is never asked for
                      more than the 1 MB. It considers this screen and saves suggested limits
                      without locking them.
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
              {/* ITS OWN CARD, lifted out of Network.

                Network had grown to eight rows and was by far the tallest
                panel on the face — the thing that made the column run off
                the bottom. It also mixed two unrelated questions: what to
                fetch and how good it should be, versus what to keep on disk
                while it plays.

                Splitting them is what makes the second question skippable.
                Somebody streaming straight from TorBox and keeping nothing
                can ignore this whole card, and the rows that only mean
                something on disk disappear the moment they say so. */}
              <section
                className={`${styles.section} glass-panel`}
                aria-labelledby="settings-storage"
              >
                <h2 id="settings-storage" className={styles.sectionTitle}>
                  Storage while playing
                </h2>
                {/* THE QUESTION EVERYTHING ELSE IN THIS CARD DEPENDS ON.

                  Asked once at first run and answerable again here. "No"
                  is a promise rather than a preference: the main process
                  forces the cache to memory behind it (preferences.ts
                  effectiveCacheMode), so the disk stays clean whatever the
                  saved mode says — hiding these controls is the cosmetic
                  half of it, not the mechanism. */}
                <ToggleRow
                  icon="downloads"
                  title="Keep media on this device"
                  description="Off streams everything and writes no video to your disk — the buffer lives in memory and is gone when playback stops. Your library, history and settings are kept either way."
                  checked={mediaHubSettings?.storeMedia !== false}
                  onChange={(value) => setStoreMedia(value)}
                />
                {mediaHubSettings?.storeMedia !== false && (
                  <>
                    <SegmentedRow
                      icon="downloads"
                      title="Where the buffer lives"
                      description="Cache to disk buffers ahead on your drive, so you can rewind freely and resume later. Memory only keeps everything in RAM and writes nothing about what you watch to disk — it needs a faster connection and gives you a shorter buffer."
                      value={mediaHubSettings?.cacheMode ?? 'disk'}
                      options={CACHE_MODE_OPTIONS}
                      onChange={(value) => setCacheMode(value as CacheMode)}
                    />
                    {mediaHubSettings?.cacheMode === 'memory' ? (
                      <div className={styles.row}>
                        <div className={styles.rowIcon} aria-hidden="true">
                          <Icon name="downloads" size={17} />
                        </div>
                        <div className={styles.rowText}>
                          <span className={styles.rowTitle}>Memory buffer</span>
                          <span className={styles.rowDescription}>
                            Using up to {mediaHubSettings?.memoryCacheMaxMb ?? 512} MB of RAM.
                            Nothing is written to disk, so there is nothing left behind when
                            playback stops — and nothing to resume from either.
                          </span>
                        </div>
                      </div>
                    ) : (
                      <CacheSizeRow
                        icon="downloads"
                        title="Stream cache size"
                        description="How much local disk playback can use to buffer ahead and rewind without reopening a connection to the source. Larger also enables extracting embedded subtitle tracks, which needs the whole file cached. Pick a preset or type your own value in GB."
                        valueGb={mediaHubSettings?.streamCacheMaxGb ?? 10}
                        presets={STREAM_CACHE_SIZE_OPTIONS}
                        onChange={setStreamCacheSize}
                      />
                    )}
                    {/* DISK ONLY. Where the cache lives and a button to clear it
                  mean nothing when nothing is being written to disk — in
                  memory-only they were two controls that could not do
                  anything, which is exactly the redundancy worth removing
                  rather than greying out. */}
                    {mediaHubSettings?.cacheMode !== 'memory' && (
                      <>
                        <div className={styles.row}>
                          <div className={styles.rowIcon} aria-hidden="true">
                            <Icon name="downloads" size={17} />
                          </div>
                          <div className={styles.rowText}>
                            <span className={styles.rowTitle}>Stream cache location</span>
                            <span className={styles.rowDescription}>
                              {mediaHubSettings?.streamCacheDir || 'Default (app data folder)'} —
                              useful for pointing it at a secondary drive. Anything cached at the
                              old location is cleared when you change this, so nothing is left where
                              the app can no longer reach it.
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
                              Buffered video data kept on disk for smooth seeking. Whatever is
                              actively playing right now is never cleared.
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
                        {streamCacheClearStatus.kind !== 'idle' &&
                          streamCacheClearStatus.kind !== 'busy' && (
                            <span
                              className={`${styles.statusMessage} ${streamCacheClearStatus.kind === 'ok' ? styles.statusOk : styles.statusError}`}
                            >
                              {streamCacheClearStatus.message}
                            </span>
                          )}
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
          </section>
        )}

        {shows('services') && (
          <section
            id="settings-services"
            ref={servicesGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-services-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>Library</span>
              <h2 id="settings-services-title">Media services</h2>
              <p>Connect servers, download clients, and your streaming provider.</p>
            </header>
            <div
              ref={servicesGridBinding}
              className={`${styles.groupGrid} ${styles.groupGridWide}`}
            >
              {/* Only on the standalone /settings route. Inside the control
                centre the cache server has its own section in the rail,
                with the administration this card cannot hold, and two
                copies of the pairing flow on one surface is a way to have
                them disagree. */}
              {!embedded && <LanCacheSection />}
              <MediaServicesSection />
              <TorBoxSection />
            </div>
          </section>
        )}

        {shows('accounts') && (
          <section
            id="settings-accounts"
            ref={accountsGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-accounts-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>Connections</span>
              <h2 id="settings-accounts-title">Accounts</h2>
              <p>
                Three kinds of connection, doing three different jobs. Nothing here is required —
                the app works without any of them, and each one adds what it says it adds.
              </p>
            </header>

            {/* THREE SUBGROUPS, NOT SEVEN EQUAL TILES.
                These cards were one flat grid in the order they happened to
                be written: TMDB, OMDb, Simkl, Trakt, MAL, SubDL,
                OpenSubtitles. Nothing said which of them tracked what you
                watched, which fetched artwork, and which found subtitles,
                so a person looking for one had to read all seven. They do
                genuinely different jobs and now say so.

                It also gives the watchlist panel somewhere to belong.
                Dropped into that flat grid it was an eighth tile of a
                different kind — an action and a report among a row of
                credential forms. Under Tracking, spanning the row it
                reports on, it reads as the summary of that group, which is
                what it is. */}
            <div className={styles.subGroup}>
              <div className={styles.subGroupHead}>
                <h3>Tracking</h3>
                <p>
                  What you watch and what you plan to. History goes out to all of these; watchlists
                  come back from all of these.
                </p>
              </div>
              <div className={styles.groupGrid}>
                <SimklSection />
                <TraktSection />
                <MalSection />
              </div>
              <WatchlistSyncSection />
            </div>

            <div className={styles.subGroup}>
              <div className={styles.subGroupHead}>
                <h3>Artwork &amp; metadata</h3>
                <p>
                  Posters, backdrops, cast and ratings. Without them titles still play — they just
                  look plainer and carry less to browse by.
                </p>
              </div>
              <div className={styles.groupGrid}>
                <TmdbSection />
                <OmdbSection />
              </div>
            </div>

            <div className={styles.subGroup}>
              <div className={styles.subGroupHead}>
                <h3>Subtitles</h3>
                <p>Where subtitles are searched for, in the order you have them connected.</p>
              </div>
              <div className={styles.groupGrid}>
                <SubDLSection />
                <OpenSubtitlesSection />
              </div>
            </div>
          </section>
        )}

        {/* Its own group rather than a tile inside General: this is the one
            place that decides whether the app's AI features do anything at
            all, and it should be as findable as the account connections
            above it. */}
        {shows('ai') && (
          <section
            id="settings-ai"
            ref={aiGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-ai-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>Assistant</span>
              <h2 id="settings-ai-title">AI</h2>
              <p>Run the assistant and recommendations on a model of your own.</p>
            </header>
            <div ref={aiGridBinding} className={styles.groupGrid}>
              <OllamaSection />
            </div>
          </section>
        )}

        {shows('community') && (
          <section
            id="settings-community"
            ref={communityGroupBinding}
            className={styles.settingsGroup}
            aria-labelledby="settings-community-title"
          >
            <header className={styles.groupHeader}>
              <span className={styles.groupEyebrow}>People</span>
              <h2 id="settings-community-title">Community &amp; profiles</h2>
              <p>Set up shared viewing and choose who is watching.</p>
            </header>
            <div ref={communityGridBinding} className={styles.groupGrid}>
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
        )}
      </div>
    </div>
  )
}
