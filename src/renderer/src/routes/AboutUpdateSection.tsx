import { useEffect, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useAsyncAction } from '@renderer/hooks/useAsyncAction'
import type { UpdateChannel, UpdateState, UpdateStatusPayload } from '@shared/media-hub/types'
import styles from './Settings.module.css'

const STATE_LABEL: Record<UpdateState, string> = {
  development: "Auto-update is disabled in development builds — this is what you're running now.",
  checking: 'Checking for updates…',
  available: 'An update is available and downloading…',
  downloading: 'Downloading update…',
  ready: 'Update downloaded — restart to install.',
  current: "You're on the latest version.",
  error: "Couldn't check for updates."
}

/**
 * First tile in Settings — the one place to see what build is running and
 * pull the latest one. Wraps the update:check/install/set-channel IPC
 * (main/media-hub/autoUpdate.ts) and the appVersion already returned by
 * settings:get (AppStateContext's mediaHubSettings) — both existed with no
 * renderer call site before this.
 */
export function AboutUpdateSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null)
  const [checking, setChecking] = useState(false)
  const [notes, setNotes] = useState('')
  const runAction = useAsyncAction()

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api) return
    return api.update.onStatus(setStatus)
  }, [])

  // The running build's own note. Read once — it is baked into the build and
  // cannot change while the app is open. A build made outside the release
  // workflow has none, which is why an empty answer renders nothing at all
  // rather than an empty heading.
  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api) return
    void Promise.resolve().then(async () => {
      try {
        const result = await api.update.notes()
        setNotes(result.current)
      } catch {
        // Nothing to say is the normal case, so a failure to read says nothing.
      }
    })
  }, [])

  async function handleCheck() {
    const api = window.api?.mediaHub
    if (!api) return
    setChecking(true)
    try {
      const result = await api.update.check()
      setStatus({ state: result.state, version: result.version })
    } catch (error) {
      setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Update check failed.'
      })
    } finally {
      setChecking(false)
    }
  }

  async function handleInstall() {
    const api = window.api?.mediaHub
    if (!api) return
    await runAction({
      scope: 'update.install',
      action: () => api.update.install(),
      errorMessage: "Couldn't restart to install the update.",
      retry: true
    })
  }

  async function handleSetChannel(channel: UpdateChannel) {
    const api = window.api?.mediaHub
    if (!api || channel === mediaHubSettings?.updateChannel) return
    const result = await runAction({
      scope: 'update.set-channel',
      action: () => api.update.setChannel(channel),
      errorMessage: "Couldn't change the update channel.",
      successMessage: `Update channel changed to ${channel}.`,
      retry: true
    })
    if (result.ok) refreshMediaHubSettings()
  }

  const version = mediaHubSettings?.appVersion
  const channel = mediaHubSettings?.updateChannel ?? 'stable'
  const bridgeMissing = !window.api?.mediaHub

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-about">
      <h2 id="settings-about" className={styles.sectionTitle}>
        About &amp; Updates
      </h2>

      <div className={styles.versionRow}>
        <span className={styles.versionLabel}>R3 Media Center</span>
        <span className={styles.versionNumber}>{version ? `v${version}` : '—'}</span>
      </div>

      {bridgeMissing ? (
        <p className={styles.statusMessage}>
          Running outside the Electron shell — updates can&apos;t be checked here.
        </p>
      ) : (
        <>
          <div className={styles.channelToggle} role="radiogroup" aria-label="Update channel">
            {(['stable', 'preview'] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={channel === c}
                className={`${styles.channelButton} ${channel === c ? styles.channelButtonActive : ''}`}
                onClick={() => handleSetChannel(c)}
              >
                {c === 'stable' ? 'Stable' : 'Preview'}
              </button>
            ))}
          </div>

          <div className={styles.serviceActions} style={{ marginTop: 12 }}>
            <button
              type="button"
              className={`${styles.testButton} ${styles.checkButton}`}
              onClick={handleCheck}
              disabled={checking || status?.state === 'checking'}
            >
              <Icon name="refresh" size={13} />
              {checking || status?.state === 'checking' ? 'Checking…' : 'Check for Updates'}
            </button>
            {status?.state === 'ready' && (
              <button type="button" className={styles.saveButton} onClick={handleInstall}>
                Restart &amp; Install
              </button>
            )}
          </div>

          {status && (
            <p
              className={`${styles.statusMessage} ${
                status.state === 'error'
                  ? styles.statusError
                  : status.state === 'current' || status.state === 'ready'
                    ? styles.statusOk
                    : styles.statusIdle
              }`}
              style={{ marginTop: 8 }}
            >
              {STATE_LABEL[status.state]}
              {status.state === 'downloading' &&
                status.percent !== undefined &&
                ` ${status.percent}%`}
              {(status.state === 'available' || status.state === 'ready') &&
                status.version &&
                ` (v${status.version})`}
              {status.state === 'error' && status.message ? ` ${status.message}` : ''}
            </p>
          )}

          {/* Two different notes, and only ever one of them. While an update
              is being offered or is waiting to install, what matters is what
              the NEW version changes — reading about it is the whole point of
              being told an update exists. Otherwise the note describes the
              build actually running. Labelled so the two can never be
              mistaken for each other. */}
          {(() => {
            const offered =
              (status?.state === 'available' || status?.state === 'ready') && status.releaseNotes
                ? status.releaseNotes
                : ''
            const shown = offered || notes
            if (!shown) return null
            return (
              <div className={styles.notes}>
                <span className={styles.notesLabel}>
                  {offered
                    ? `What's new in v${status?.version ?? 'the update'}`
                    : "What's new in this version"}
                </span>
                <p className={styles.notesBody}>{shown}</p>
              </div>
            )
          })()}
        </>
      )}
    </section>
  )
}
