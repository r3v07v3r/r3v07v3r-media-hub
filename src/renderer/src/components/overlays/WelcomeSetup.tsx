'use client'

// The welcome flow a fresh install walks through before anything else.
//
// Two questions, in order of how personal they are:
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
// Gated on setupComplete, which installs that predate the flow earn
// automatically from having answered the storage question (see appIpc's
// snapshot) — only genuinely fresh installs land here. The storage policy
// prompt keys itself to AFTER this flow, so first run reads as one
// sequence: who are you → where does video come from → may it touch disk.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import { testConnection as testJellyfin } from '@renderer/lib/api/jellyfin'
import styles from './WelcomeSetup.module.css'

type Step = 'name' | 'source'
type SourceMode = 'pick' | 'torbox' | 'server'
type Status = { kind: 'idle' | 'busy' | 'error'; message?: string }

export function WelcomeSetup() {
  const { mediaHubSettings, refreshMediaHubSettings, refreshProfiles } = useAppState()
  const [step, setStep] = useState<Step>('name')
  const [nameEdited, setNameEdited] = useState<string | null>(null)
  const [mode, setMode] = useState<SourceMode>('pick')
  const [torboxToken, setTorboxToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [serverKey, setServerKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
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
    panel.focus()
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
        await finish()
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
      await finish()
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Connect failed.'
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
        {step === 'name' ? (
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
        ) : (
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
                  onClick={() => void finish()}
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
      </div>
    </div>
  )
}
