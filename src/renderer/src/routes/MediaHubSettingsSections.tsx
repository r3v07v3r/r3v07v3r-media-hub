import { useEffect, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import type {
  MalReconcilePreview,
  SimklPinStart,
  SimklStatus,
  MalStatus,
  PartyMode
} from '@shared/media-hub/types'
import styles from './Settings.module.css'

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string }

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null
  const cls =
    status.kind === 'ok'
      ? styles.statusOk
      : status.kind === 'error'
        ? styles.statusError
        : styles.statusIdle
  return (
    <span className={`${styles.statusMessage} ${cls}`}>
      {status.kind === 'busy' ? 'Working…' : status.message}
    </span>
  )
}

/** Small "Connected" / "Not connected" pill next to a section title — every
 *  sub-section below follows the same connect/disconnect shape (a token or
 *  OAuth-style flow gating one bool), so this is factored out once rather
 *  than repeated five times. */
function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`${styles.statusMessage} ${connected ? styles.statusOk : styles.statusIdle}`}>
      {connected ? (
        <>
          <Icon name="check" size={11} /> Connected
        </>
      ) : (
        'Not connected'
      )}
    </span>
  )
}

/**
 * TorBox — the streaming backend everything in this app plays through
 * (see PlaybackOverlay/AppStateContext's startPlayback gate). Token-only
 * connect; the backend never hands the token back, so there's nothing to
 * pre-fill once connected, only a "Connected" state + Disconnect.
 */
export function TorBoxSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.torboxConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !token.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.torbox.connect(token.trim())
      if (result.ok) {
        setToken('')
        setStatus({ kind: 'ok', message: 'Connected.' })
        refreshMediaHubSettings()
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

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    await api.torbox.disconnect().catch(() => {})
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-torbox">
      <div className={styles.serviceHead}>
        <h2 id="settings-torbox" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          TorBox
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Powers every stream this app plays — required before any title will actually start playing
        (the dashboard itself stays fully browsable without it).
      </p>
      {connected ? (
        <div className={styles.serviceActions}>
          <button type="button" className={styles.testButton} onClick={disconnect}>
            Disconnect
          </button>
          <StatusLine status={status} />
        </div>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>TorBox API Token</span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder="••••••••••••"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={connect}
              disabled={!token.trim() || status.kind === 'busy'}
            >
              {status.kind === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
            <StatusLine status={status} />
          </div>
        </>
      )}
    </section>
  )
}

/** TMDB — optional richer artwork/metadata lookups layered on top of the
 *  Simkl/Kitsu/Cinemeta catalog data. Same token-connect shape as TorBox. */
export function TmdbSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.tmdbConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !apiKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.tmdb.connect(apiKey.trim())
      if (result.ok) {
        setApiKey('')
        setStatus({ kind: 'ok', message: 'Connected.' })
        refreshMediaHubSettings()
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

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    await api.tmdb.disconnect().catch(() => {})
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-tmdb">
      <div className={styles.serviceHead}>
        <h2 id="settings-tmdb" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          TMDB
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Optional — enriches artwork and metadata beyond what Simkl/Kitsu/Cinemeta already provide.
      </p>
      {connected ? (
        <div className={styles.serviceActions}>
          <button type="button" className={styles.testButton} onClick={disconnect}>
            Disconnect
          </button>
          <StatusLine status={status} />
        </div>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>TMDB API Key</span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder="••••••••••••"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={connect}
              disabled={!apiKey.trim() || status.kind === 'busy'}
            >
              {status.kind === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
            <StatusLine status={status} />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Simkl — watch-history tracking/scrobbling, device-code OAuth (the same
 * flow Simkl's own apps use): start() returns a short user code + a
 * verification URL to open in a browser, then poll() until the person has
 * approved it there or the code expires. `simklClientId` lives in the
 * shared settings snapshot, but the live connected/user state doesn't
 * (see MediaHubSettingsSnapshot) — fetched here from simkl.status()
 * directly, same as MAL below.
 */
export function SimklSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [clientId, setClientId] = useState('')
  const [status, setStatus] = useState<SimklStatus | null>(null)
  const [pin, setPin] = useState<SimklPinStart | null>(null)
  const [connectStatus, setConnectStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api) return
    api.simkl
      .status()
      .then(setStatus)
      .catch(() => {})
  }, [])

  useEffect(() => {
    // Deferred via a resolved microtask (see MediaServicesSection's load
    // effect for the same pattern) rather than a synchronous setState in
    // the effect body — this seeds the client-id field once the shared
    // settings snapshot arrives/changes; the field stays freely editable
    // after that.
    const id = mediaHubSettings?.simklClientId ?? ''
    Promise.resolve().then(() => setClientId(id))
  }, [mediaHubSettings?.simklClientId])

  // Polls simkl.poll() every `interval` seconds against the active pin
  // until the person approves the code on Simkl's site (connected: true)
  // or it expires — mirrors the flow the ported r3v07v3r-media-hub app
  // used for its own (non-Electron) Simkl device-code login screen.
  useEffect(() => {
    if (!pin) return
    const api = window.api?.mediaHub
    if (!api) return
    let cancelled = false
    let remaining = pin.expires_in
    const id = setInterval(
      () => {
        remaining -= pin.interval
        if (remaining <= 0) {
          if (!cancelled) {
            setConnectStatus({ kind: 'error', message: 'Code expired — try again.' })
            setPin(null)
          }
          clearInterval(id)
          return
        }
        api.simkl
          .poll(pin.user_code)
          .then((result) => {
            if (cancelled) return
            if (result.connected) {
              clearInterval(id)
              setPin(null)
              setConnectStatus({ kind: 'ok', message: 'Connected.' })
              refreshMediaHubSettings()
              api.simkl
                .status()
                .then(setStatus)
                .catch(() => {})
            } else if (result.message && !result.pending) {
              clearInterval(id)
              setPin(null)
              setConnectStatus({ kind: 'error', message: result.message })
            }
          })
          .catch(() => {})
      },
      Math.max(pin.interval, 2) * 1000
    )
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-armed only when a fresh pin is issued
  }, [pin])

  async function startConnect() {
    const api = window.api?.mediaHub
    if (!api || !clientId.trim()) return
    setConnectStatus({ kind: 'busy' })
    try {
      const result = await api.simkl.start(clientId.trim())
      setPin(result)
      setConnectStatus({ kind: 'idle' })
    } catch (error) {
      setConnectStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not start Simkl login.'
      })
    }
  }

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setConnectStatus({ kind: 'busy' })
    await api.simkl.disconnect().catch(() => {})
    setPin(null)
    setConnectStatus({ kind: 'idle' })
    api.simkl
      .status()
      .then(setStatus)
      .catch(() => {})
    refreshMediaHubSettings()
  }

  const connected = status?.connected ?? false
  const verificationUrl = pin?.verification_url || pin?.verification_uri

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-simkl">
      <div className={styles.serviceHead}>
        <h2 id="settings-simkl" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          Simkl
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Syncs watch history and marks-watched to your Simkl account.
      </p>
      {connected ? (
        <div className={styles.serviceActions}>
          <button type="button" className={styles.testButton} onClick={disconnect}>
            Disconnect
          </button>
          <StatusLine status={connectStatus} />
        </div>
      ) : pin ? (
        <div className={styles.serviceFields} style={{ flexDirection: 'column', gap: 8 }}>
          <span className={styles.rowDescription}>
            Enter this code at{' '}
            <button
              type="button"
              className={styles.testButton}
              style={{ padding: '2px 8px' }}
              onClick={() => window.api?.mediaHub?.openExternal(verificationUrl || '')}
            >
              {verificationUrl}
            </button>
          </span>
          <span
            className={styles.fieldInput}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              letterSpacing: 4,
              textAlign: 'center',
              width: 'fit-content'
            }}
          >
            {pin.user_code}
          </span>
          <StatusLine status={{ kind: 'busy' }} />
        </div>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Simkl Client ID</span>
              <input
                className={styles.fieldInput}
                type="text"
                placeholder="Simkl app client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={startConnect}
              disabled={!clientId.trim() || connectStatus.kind === 'busy'}
            >
              {connectStatus.kind === 'busy' ? 'Starting…' : 'Connect'}
            </button>
            <StatusLine status={connectStatus} />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * MyAnimeList — anime tracking, kept separate from Simkl since the
 * backend syncs anime progress against MAL specifically (see
 * main/media-hub/malSync.ts). Unlike Simkl this is a direct client
 * credential connect (no device-code polling), plus an optional
 * preview/apply reconcile step to catch drift between MAL and local
 * watch history.
 */
export function MalSection() {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [status, setStatus] = useState<MalStatus | null>(null)
  const [connectStatus, setConnectStatus] = useState<Status>({ kind: 'idle' })
  const [preview, setPreview] = useState<MalReconcilePreview | null>(null)
  const [reconcileStatus, setReconcileStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api) return
    api.mal
      .status()
      .then(setStatus)
      .catch(() => {})
  }, [])

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !clientId.trim()) return
    setConnectStatus({ kind: 'busy' })
    try {
      await api.mal.start({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined
      })
      setConnectStatus({ kind: 'ok', message: 'Connected.' })
      setClientSecret('')
      api.mal
        .status()
        .then(setStatus)
        .catch(() => {})
    } catch (error) {
      setConnectStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not connect.'
      })
    }
  }

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setConnectStatus({ kind: 'busy' })
    await api.mal.disconnect().catch(() => {})
    setPreview(null)
    setConnectStatus({ kind: 'idle' })
    api.mal
      .status()
      .then(setStatus)
      .catch(() => {})
  }

  async function previewReconcile() {
    const api = window.api?.mediaHub
    if (!api) return
    setReconcileStatus({ kind: 'busy' })
    try {
      const result = await api.mal.reconcilePreview()
      setPreview(result)
      setReconcileStatus({ kind: 'idle' })
    } catch (error) {
      setReconcileStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not compare with MAL.'
      })
    }
  }

  async function applyReconcile() {
    const api = window.api?.mediaHub
    if (!api || !preview) return
    setReconcileStatus({ kind: 'busy' })
    try {
      const result = await api.mal.reconcileApply(preview)
      setPreview(null)
      setReconcileStatus({
        kind: result.errors.length ? 'error' : 'ok',
        message: `Applied ${result.toLocal.length + result.toMal.length} update${
          result.toLocal.length + result.toMal.length === 1 ? '' : 's'
        }${result.errors.length ? `, ${result.errors.length} failed` : ''}.`
      })
    } catch (error) {
      setReconcileStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Sync failed.'
      })
    }
  }

  const connected = status?.connected ?? false

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-mal">
      <div className={styles.serviceHead}>
        <h2 id="settings-mal" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          MyAnimeList
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Anime-specific progress tracking, kept in sync separately from Simkl.
      </p>
      {connected ? (
        <>
          <div className={styles.serviceActions}>
            <button type="button" className={styles.testButton} onClick={disconnect}>
              Disconnect
            </button>
            <StatusLine status={connectStatus} />
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={preview ? applyReconcile : previewReconcile}
              disabled={reconcileStatus.kind === 'busy'}
            >
              <Icon name="refresh" size={12} />{' '}
              {reconcileStatus.kind === 'busy'
                ? 'Working…'
                : preview
                  ? 'Apply sync'
                  : 'Preview sync with MAL'}
            </button>
            <StatusLine status={reconcileStatus} />
          </div>
          {preview && (
            <p className={styles.rowDescription} style={{ marginTop: 8 }}>
              {preview.toMal.length} update{preview.toMal.length === 1 ? '' : 's'} to push to MAL,{' '}
              {preview.toLocal.length} to pull in locally
              {preview.unmatched.length ? `, ${preview.unmatched.length} unmatched` : ''}.
            </p>
          )}
        </>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>MAL Client ID</span>
              <input
                className={styles.fieldInput}
                type="text"
                placeholder="MAL API client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Client Secret (optional)</span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder="••••••••••••"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={connect}
              disabled={!clientId.trim() || connectStatus.kind === 'busy'}
            >
              {connectStatus.kind === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
            <StatusLine status={connectStatus} />
          </div>
        </>
      )}
    </section>
  )
}

/** OpenSubtitles — powers the subtitle search/apply flow in PlaybackOverlay. */
export function OpenSubtitlesSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [apiKey, setApiKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.osConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !apiKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.openSubtitles.connect(apiKey.trim(), username.trim(), password)
      if (result.ok) {
        setApiKey('')
        setUsername('')
        setPassword('')
        setStatus({ kind: 'ok', message: 'Connected.' })
        refreshMediaHubSettings()
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

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    await api.openSubtitles.disconnect().catch(() => {})
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-opensubtitles">
      <div className={styles.serviceHead}>
        <h2 id="settings-opensubtitles" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          OpenSubtitles
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Subtitle search inside the player, for titles without embedded subtitle tracks.
      </p>
      {connected ? (
        <div className={styles.serviceActions}>
          <button type="button" className={styles.testButton} onClick={disconnect}>
            Disconnect
          </button>
          <StatusLine status={status} />
        </div>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>API Key</span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder="••••••••••••"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Username (optional)</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password (optional)</span>
              <input
                className={styles.fieldInput}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={connect}
              disabled={!apiKey.trim() || status.kind === 'busy'}
            >
              {status.kind === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
            <StatusLine status={status} />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * R3-Party-Sync — an optional external relay (self-hosted, see
 * party-sync-worker/ in the repo) that Watch Party can host through
 * instead of a direct LAN/WAN connection, for when a host's router won't
 * cooperate with UPnP/NAT-PMP. Configuring this here just unlocks the
 * "Relay" option in WatchPartySection below — it doesn't itself start or
 * join a party.
 */
export function R3PartySyncSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [url, setUrl] = useState('')
  const [inviteKey, setInviteKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.partySyncConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !url.trim() || !inviteKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.party.syncConnect(url.trim(), inviteKey.trim())
      if (result.ok) {
        setInviteKey('')
        setStatus({ kind: 'ok', message: result.message || 'Connected.' })
        refreshMediaHubSettings()
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

  async function disconnect() {
    const api = window.api?.mediaHub
    if (!api) return
    setStatus({ kind: 'busy' })
    await api.party.syncDisconnect().catch(() => {})
    setUrl('')
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-party-sync">
      <div className={styles.serviceHead}>
        <h2 id="settings-party-sync" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          R3-Party-Sync
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        A relay worker you deploy yourself (see party-sync-worker/ in the repo) so Watch Party can
        connect over the internet even when a router won&apos;t forward a port automatically.
      </p>
      {connected ? (
        <>
          <p className={styles.rowDescription}>{mediaHubSettings?.partySyncUrl}</p>
          <div className={styles.serviceActions}>
            <button type="button" className={styles.testButton} onClick={disconnect}>
              Disconnect
            </button>
            <StatusLine status={status} />
          </div>
        </>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Worker URL</span>
              <input
                className={styles.fieldInput}
                type="text"
                placeholder="https://r3-party-sync.your-name.workers.dev"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invite key</span>
              <input
                className={styles.fieldInput}
                type="password"
                placeholder="••••••••••••"
                value={inviteKey}
                onChange={(e) => setInviteKey(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={connect}
              disabled={!url.trim() || !inviteKey.trim() || status.kind === 'busy'}
            >
              {status.kind === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
            <StatusLine status={status} />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Watch Party — setup/connection controls only (host/join/leave, current
 * members). The live in-session queue/voting UI is a separate concern
 * from Settings and isn't part of this section; this just covers getting
 * into (or out of) a party, the same "configuration surface" scope as
 * every other section on this page.
 *
 * Reads/writes the same AppStateContext party slice the topbar's
 * PartyButton/PartyPanel use — one source of truth, so hosting/joining
 * from here is immediately reflected in the topbar and vice versa.
 */
export function WatchPartySection() {
  const { partyStatus, partyHostCode, mediaHubSettings, hostParty, joinParty, leaveParty } =
    useAppState()
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [mode, setMode] = useState<PartyMode>('direct')
  const [actionStatus, setActionStatus] = useState<Status>({ kind: 'idle' })
  const relayReady = mediaHubSettings?.partySyncConnected ?? false

  async function host() {
    if (!name.trim()) return
    setActionStatus({ kind: 'busy' })
    try {
      await hostParty(name.trim(), relayReady ? mode : 'direct')
      setActionStatus({ kind: 'idle' })
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not start a party.'
      })
    }
  }

  async function join() {
    if (!joinCode.trim() || !name.trim()) return
    setActionStatus({ kind: 'busy' })
    try {
      await joinParty(joinCode.trim(), name.trim())
      setActionStatus({ kind: 'idle' })
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not join that party.'
      })
    }
  }

  async function leave() {
    setActionStatus({ kind: 'busy' })
    await leaveParty().catch(() => {})
    setActionStatus({ kind: 'idle' })
  }

  const inParty = partyStatus?.inParty ?? false

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-party">
      <div className={styles.serviceHead}>
        <h2 id="settings-party" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          Watch Party
        </h2>
        <ConnectionBadge connected={inParty} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Watch something together, in sync, with a shareable code.
      </p>
      {inParty ? (
        <>
          <p className={styles.rowDescription}>
            {partyStatus?.role === 'host' ? 'Hosting' : 'Joined'} as {partyStatus?.selfName}
            {partyHostCode && (
              <>
                {' '}
                — code <strong>{partyHostCode}</strong>
              </>
            )}
            {partyStatus?.members?.length ? ` · ${partyStatus.members.length} in the party` : ''}
          </p>
          <div className={styles.serviceActions}>
            <button type="button" className={styles.testButton} onClick={leave}>
              Leave party
            </button>
            <StatusLine status={actionStatus} />
          </div>
        </>
      ) : (
        <>
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Your name</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Party code (to join one)</span>
              <input
                className={styles.fieldInput}
                type="text"
                placeholder="Leave blank to host instead"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
            </label>
          </div>
          {!joinCode.trim() && relayReady && (
            <div className={styles.segmentGroup} role="radiogroup" aria-label="Party mode">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'direct'}
                className={`${styles.segmentButton} ${mode === 'direct' ? styles.segmentButtonActive : ''}`}
                onClick={() => setMode('direct')}
              >
                Direct
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'relay'}
                className={`${styles.segmentButton} ${mode === 'relay' ? styles.segmentButtonActive : ''}`}
                onClick={() => setMode('relay')}
              >
                Relay
              </button>
            </div>
          )}
          <div className={styles.serviceActions} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.testButton}
              onClick={joinCode.trim() ? join : host}
              disabled={!name.trim() || actionStatus.kind === 'busy'}
            >
              <Icon name="people" size={12} />{' '}
              {actionStatus.kind === 'busy'
                ? 'Working…'
                : joinCode.trim()
                  ? 'Join party'
                  : 'Host a party'}
            </button>
            <StatusLine status={actionStatus} />
          </div>
        </>
      )}
    </section>
  )
}
