'use client'

// The welcome flow a fresh install walks through before anything else.
//
// Four steps, in order of how personal they are:
//
//  1. A name. It becomes the profile's name AND the party display name in
//     one stroke — Rooms and Watch Parties introduce this install to other
//     people by partyDisplayName, and before this flow existed a fresh
//     install showed up as 'A friend' or 'Someone' until the name was
//     typed as a side-effect of hosting a party. Asking once, up front,
//     is what keeps those fallbacks from ever being seen.
//
//  2. A playback source. The catalog browses fine without one, but Play
//     does nothing until TorBox or a media server is connected (see the
//     torboxConnected/mediaServerConnected gate in AppStateContext's
//     runPlayback) — so the choice is offered here, with "not right now"
//     as an honest option that says exactly what it costs.
//
//  3. The storage question — the same StoragePolicyChoice the standalone
//     prompt renders, asked here so first run is one sequence instead of
//     a second dialog appearing after the wizard closes. "Stream only"
//     ends the flow: memory mode has no cache to tune.
//
//  4. Cache tuning, disk mode only. Runs the existing self-limiting speed
//     test (network.speedTest — the same one Settings uses) and a disk
//     probe, then recommends a quality cap, a release-size cap, a cache
//     size sized to the drive's free space, and points out a roomier
//     drive when one exists. All applied through the same settings IPC
//     the Settings page uses; all skippable.
//
// Gated on setupComplete, which installs that predate the flow earn once
// at startup from having answered the storage question (see appIpc's
// migration) — only genuinely fresh installs land here.

import { useEffect, useRef, useState } from 'react'
import type {
  CacheDiskProbeResult,
  ConnectionTestResult as SpeedTestResult
} from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import { testConnection as testJellyfin } from '@renderer/lib/api/jellyfin'
import { StoragePolicyChoice } from './StoragePolicyPrompt'
import styles from './WelcomeSetup.module.css'

type Step = 'name' | 'source' | 'storage' | 'tuning'
type SourceMode = 'pick' | 'torbox' | 'server'
type Status = { kind: 'idle' | 'busy' | 'error'; message?: string }

const RESOLUTION_LABELS: Record<number, string> = {
  480: '480p',
  720: '720p',
  1080: '1080p',
  1440: '1440p',
  2160: '4K'
}

/** How much disk the rolling cache should claim, from how much is free on
 *  the drive that holds it. Deliberately conservative fractions — the cache
 *  is a convenience, not a tenant; the floor matches streamCache.ts's
 *  MIN_CACHE_BYTES (1.5 GB) rounded up. */
function recommendCacheGb(freeGb: number): number {
  if (freeGb >= 1000) return 100
  if (freeGb >= 500) return 75
  if (freeGb >= 250) return 50
  if (freeGb >= 100) return 25
  if (freeGb >= 40) return 10
  return Math.max(2, Math.floor(freeGb / 4))
}

export function WelcomeSetup() {
  const { mediaHubSettings, refreshMediaHubSettings, refreshProfiles } = useAppState()
  const [step, setStep] = useState<Step>('name')
  const [nameEdited, setNameEdited] = useState<string | null>(null)
  const [mode, setMode] = useState<SourceMode>('pick')
  const [torboxToken, setTorboxToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [serverKey, setServerKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Tuning-step probe results. null = still running (or never run);
  // speedError distinguishes "failed" from "pending" so the step can offer
  // what it does have instead of spinning forever on a dead connection.
  const [diskProbe, setDiskProbe] = useState<CacheDiskProbeResult | null>(null)
  const [speed, setSpeed] = useState<SpeedTestResult | null>(null)
  const [speedError, setSpeedError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const visible = Boolean(mediaHubSettings) && !mediaHubSettings?.setupComplete

  // Derived, not synced (same idiom as SessionHub's name field): a restart
  // mid-flow re-opens the flow (setupComplete is only written at the very
  // end), and a name saved before the restart is offered back untyped.
  const name = nameEdited ?? mediaHubSettings?.partyDisplayName ?? ''

  // Same focus trap as StoragePolicyPrompt, for the same reason: the scrim
  // stops a mouse but not a keyboard, and the app behind is inert (see
  // AppShell) — Tab must cycle here. Inputs join the cycle.
  useEffect(() => {
    const panel = panelRef.current
    if (!visible || !panel) return
    const previous = document.activeElement as HTMLElement | null
    // Re-run on step/mode changes to rebind the trap — but only take focus
    // when it is not already inside the panel, so a step's autoFocus input
    // keeps it.
    if (!panel.contains(document.activeElement)) panel.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')
      ]
      if (focusable.length === 0) return
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
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [visible, step, mode])

  if (!visible) return null

  const submitName = async (): Promise<void> => {
    const api = window.api?.mediaHub
    const trimmed = name.trim().slice(0, 40)
    if (!api || !trimmed) return
    setStatus({ kind: 'busy' })
    try {
      // One name, two homes: the party display name (what Rooms and Watch
      // Parties call this install) and the auto-seeded profile, which is
      // otherwise stuck introducing its owner as "Profile 1".
      await api.settings.setPartyDisplayName(trimmed)
      const listed = await api.profiles.list().catch(() => null)
      const activeId = listed?.activeProfileId
      if (activeId) {
        await api.profiles.update({ id: activeId, name: trimmed }).catch(() => {})
      }
      refreshProfiles()
      refreshMediaHubSettings()
      setStatus({ kind: 'idle' })
      setStep('source')
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not save the name.'
      })
    }
  }

  const finish = async (): Promise<void> => {
    setStatus({ kind: 'busy' })
    try {
      await window.api?.mediaHub?.settings.completeSetup()
    } finally {
      // Refresh regardless: if the write somehow failed the flow simply
      // shows again, which beats being wedged behind a scrim.
      refreshMediaHubSettings()
    }
  }

  const connectTorbox = async (): Promise<void> => {
    const api = window.api?.mediaHub
    if (!api || !torboxToken.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.torbox.connect(torboxToken.trim())
      if (result.ok) {
        refreshMediaHubSettings()
        setStatus({ kind: 'idle' })
        setStep('storage')
      } else {
        setStatus({ kind: 'error', message: result.message || 'Could not connect.' })
      }
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Connect failed.'
      })
    }
  }

  const connectServer = async (): Promise<void> => {
    const settingsApi = window.api?.settings
    if (!settingsApi || !serverUrl.trim() || !serverKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const config = { baseUrl: serverUrl.trim(), apiKey: serverKey.trim(), enabled: true }
      // Test first, save only what worked — the same contract as the
      // Settings page, where nothing pretends to be connected untested.
      const test = await testJellyfin(config)
      if (!test.ok) {
        setStatus({ kind: 'error', message: test.message || 'Could not reach the server.' })
        return
      }
      // Merged onto the latest stored settings, matching MediaServicesSection.
      const latest = await settingsApi.get()
      await settingsApi.set({ ...latest, jellyfin: config })
      refreshMediaHubSettings()
      setStatus({ kind: 'idle' })
      setStep('storage')
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Connect failed.'
      })
    }
  }

  const startTuningProbes = (): void => {
    const api = window.api?.mediaHub
    if (!api) return
    setSpeed(null)
    setSpeedError(null)
    api.settings
      .cacheDiskProbe()
      .then(setDiskProbe)
      .catch(() => setDiskProbe(null))
    // Same call and same screen-derived cap as the Settings page's test.
    api.network
      .speedTest(window.screen.height * window.devicePixelRatio)
      .then(setSpeed)
      .catch((error: unknown) =>
        setSpeedError(error instanceof Error ? error.message : 'Could not test this connection.')
      )
  }

  const chooseStorage = async (storeMedia: boolean): Promise<void> => {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    try {
      await api.settings.setStoreMedia(storeMedia)
      refreshMediaHubSettings()
      if (!storeMedia) {
        // Memory mode has no cache to size or place — the tuning step
        // would have nothing to recommend.
        await finish()
        return
      }
      setStatus({ kind: 'idle' })
      startTuningProbes()
      setStep('tuning')
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not save that.'
      })
    }
  }

  const cacheDrive = diskProbe?.drives.find((d) => d.isCacheDrive) ?? null
  const recommendedCacheGb = cacheDrive ? recommendCacheGb(cacheDrive.freeGb) : null
  // A drive worth mentioning: dramatically more room than where the cache
  // sits today, and enough of it to matter in absolute terms.
  const roomierDrive =
    diskProbe && cacheDrive
      ? (diskProbe.drives.find(
          (d) =>
            !d.isCacheDrive &&
            d.freeGb > cacheDrive.freeGb * 2 &&
            d.freeGb - cacheDrive.freeGb > 100
        ) ?? null)
      : null

  const applyTuning = async (): Promise<void> => {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    try {
      if (speed) {
        await api.settings.setStreamLimits({
          maxStreamResolution: speed.recommendedResolution,
          maxStreamSizeGb: speed.recommendedSizeGb,
          connectionSpeedMbps: speed.speedMbps
        })
      }
      if (recommendedCacheGb !== null) {
        await api.settings.setStreamCacheSize(recommendedCacheGb)
      }
      await finish()
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not apply the recommendations.'
      })
    }
  }

  const pickCacheDir = async (): Promise<void> => {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.settings.chooseStreamCacheDir()
      if (result.error) {
        setStatus({ kind: 'error', message: result.error })
        return
      }
      setStatus({ kind: 'idle' })
      if (result.streamCacheDir && !result.cancelled) {
        refreshMediaHubSettings()
        // Re-probe so the size recommendation follows the cache to its
        // new drive.
        api.settings
          .cacheDiskProbe()
          .then(setDiskProbe)
          .catch(() => {})
      }
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not change the folder.'
      })
    }
  }

  const busy = status.kind === 'busy'

  return (
    <div className={styles.scrim} role="presentation">
      <div
        ref={panelRef}
        className={`${styles.panel} glass-panel`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-setup-title"
        tabIndex={-1}
      >
        {step === 'name' && (
          <>
            <span className={styles.mark} aria-hidden="true">
              <Icon name="smiley" size={22} />
            </span>
            <h1 id="welcome-setup-title" className={styles.title}>
              Welcome to R3
            </h1>
            <p className={styles.body}>
              First things first — what should we call you? This becomes your profile name, and
              it&apos;s how friends see you in Rooms and Watch Parties.
            </p>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                void submitName()
              }}
            >
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Your name</span>
                <input
                  className={styles.input}
                  type="text"
                  autoFocus
                  maxLength={40}
                  placeholder="e.g. Graham"
                  value={name}
                  onChange={(event) => setNameEdited(event.target.value)}
                />
              </label>
              {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
              <div className={styles.actions}>
                <button type="submit" className={styles.primary} disabled={!name.trim() || busy}>
                  {busy ? 'Saving…' : 'Continue'}
                </button>
              </div>
            </form>
            <p className={styles.note}>You can change it any time in Settings.</p>
          </>
        )}

        {step === 'source' && (
          <>
            <span className={styles.mark} aria-hidden="true">
              <Icon name="play" size={22} />
            </span>
            <h1 id="welcome-setup-title" className={styles.title}>
              Where should video come from?
            </h1>
            <p className={styles.body}>
              Browsing works either way — but nothing will actually play until one of these is
              connected. Either alone is a complete setup.
            </p>

            {mode === 'pick' && (
              <div className={styles.choices}>
                <button
                  type="button"
                  className={styles.choiceCard}
                  onClick={() => {
                    setStatus({ kind: 'idle' })
                    setMode('torbox')
                  }}
                >
                  <strong>Connect TorBox</strong>
                  <span>
                    Streams everything in the catalog. You&apos;ll need the API token from TorBox
                    Settings.
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.choiceCard}
                  onClick={() => {
                    setStatus({ kind: 'idle' })
                    setMode('server')
                  }}
                >
                  <strong>Connect a media server</strong>
                  <span>
                    A Jellyfin server on your network — titles it already has play from there.
                  </span>
                </button>
              </div>
            )}

            {mode === 'torbox' && (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault()
                  void connectTorbox()
                }}
              >
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>TorBox API Token</span>
                  <input
                    className={styles.input}
                    type="password"
                    autoFocus
                    placeholder="••••••••••••"
                    value={torboxToken}
                    onChange={(event) => setTorboxToken(event.target.value)}
                  />
                </label>
                {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => {
                      setStatus({ kind: 'idle' })
                      setMode('pick')
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className={styles.primary}
                    disabled={!torboxToken.trim() || busy}
                  >
                    {busy ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </form>
            )}

            {mode === 'server' && (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault()
                  void connectServer()
                }}
              >
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Server URL</span>
                  <input
                    className={styles.input}
                    type="text"
                    autoFocus
                    placeholder="http://192.168.1.10:8096"
                    value={serverUrl}
                    onChange={(event) => setServerUrl(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>API Key</span>
                  <input
                    className={styles.input}
                    type="password"
                    placeholder="••••••••"
                    value={serverKey}
                    onChange={(event) => setServerKey(event.target.value)}
                  />
                </label>
                {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => {
                      setStatus({ kind: 'idle' })
                      setMode('pick')
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className={styles.primary}
                    disabled={!serverUrl.trim() || !serverKey.trim() || busy}
                  >
                    {busy ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </form>
            )}

            {mode === 'pick' && (
              <div className={styles.skipRow}>
                <button
                  type="button"
                  className={styles.skipButton}
                  disabled={busy}
                  onClick={() => {
                    setStatus({ kind: 'idle' })
                    setStep('storage')
                  }}
                >
                  Not right now
                </button>
                <span className={styles.skipNote}>
                  You can browse, but nothing will play until a source is connected in Settings.
                </span>
              </div>
            )}
          </>
        )}

        {step === 'storage' && (
          <>
            <span className={styles.mark} aria-hidden="true">
              <Icon name="downloads" size={22} />
            </span>
            <h1 id="welcome-setup-title" className={styles.title}>
              Keep media on this device?
            </h1>
            <StoragePolicyChoice
              busy={busy}
              onChoose={(storeMedia) => void chooseStorage(storeMedia)}
            />
            {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
          </>
        )}

        {step === 'tuning' && (
          <>
            <span className={styles.mark} aria-hidden="true">
              <Icon name="pulse" size={22} />
            </span>
            <h1 id="welcome-setup-title" className={styles.title}>
              Let&apos;s size your cache
            </h1>
            <p className={styles.body}>
              A quick download test measures your connection, and your drives tell us how much room
              the cache can take. Everything here can be changed later in Settings.
            </p>
            <ul className={styles.tuneRows}>
              <li>
                <strong>Connection</strong>
                {speed ? (
                  <span>
                    {speed.speedMbps} Mbps — good for{' '}
                    {RESOLUTION_LABELS[speed.recommendedResolution] ??
                      `${speed.recommendedResolution}p`}{' '}
                    streams.
                  </span>
                ) : speedError ? (
                  <span className={styles.tuneError}>{speedError}</span>
                ) : (
                  <span className={styles.tunePending}>Measuring… this takes a few seconds.</span>
                )}
              </li>
              {speed && (
                <li>
                  <strong>Quality</strong>
                  <span>
                    Cap releases at{' '}
                    {RESOLUTION_LABELS[speed.recommendedResolution] ??
                      `${speed.recommendedResolution}p`}{' '}
                    and about {speed.recommendedSizeGb} GB per title, so streams start fast and
                    never outrun the line.
                  </span>
                </li>
              )}
              <li>
                <strong>Cache size</strong>
                {cacheDrive && recommendedCacheGb !== null ? (
                  <span>
                    {recommendedCacheGb} GB on {cacheDrive.root} ({Math.round(cacheDrive.freeGb)} GB
                    free).
                  </span>
                ) : (
                  <span className={styles.tunePending}>Checking your drives…</span>
                )}
              </li>
              <li>
                <strong>Location</strong>
                <span>
                  {diskProbe?.cacheDir ?? 'The default app folder.'}
                  {roomierDrive
                    ? ` ${roomierDrive.root} has ${Math.round(roomierDrive.freeGb)} GB free — worth considering.`
                    : ''}
                </span>
                <button
                  type="button"
                  className={styles.inlineButton}
                  disabled={busy}
                  onClick={() => void pickCacheDir()}
                >
                  Choose a different folder…
                </button>
              </li>
            </ul>
            {status.kind === 'error' && <p className={styles.error}>{status.message}</p>}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => void finish()}
              >
                Keep defaults
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={
                  busy || (!speed && !speedError) || (!speed && recommendedCacheGb === null)
                }
                onClick={() => void applyTuning()}
              >
                {busy ? 'Applying…' : 'Apply recommendations'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
