import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { DEFAULT_OLLAMA_BASE_URL, pickInstalledModel } from '@shared/media-hub/ollama'
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

/** OMDb — optional Rotten Tomatoes critic scores layered onto the movie/
 *  series ratings panel. Same token-connect shape as TMDB; never applies
 *  to anime (see catalog.ts's metadata()), so its "Connected" state only
 *  ever affects movie/series detail pages. */
export function OmdbSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.omdbConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !apiKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.omdb.connect(apiKey.trim())
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
    await api.omdb.disconnect().catch(() => {})
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-omdb">
      <div className={styles.serviceHead}>
        <h2 id="settings-omdb" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          OMDb
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Optional — adds Rotten Tomatoes scores to the ratings panel for movies and series (no anime
        coverage). Get a free key at omdbapi.com/apikey.aspx.
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
              <span className={styles.fieldLabel}>OMDb API Key</span>
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

/**
 * SubDL — the other half of the subtitle search/apply flow in
 * PlaybackOverlay, and the one to connect if only one gets connected.
 *
 * One field, because that is genuinely all it needs: the free key
 * authenticates search (2000 requests/day), and the subtitle archives it
 * points at are public files on dl.subdl.com fetched with no credential at
 * all. That is the whole reason this provider is here — OpenSubtitles meters
 * downloads at 5/day on a free account, which a single evening exhausts.
 */
export function SubDLSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const connected = mediaHubSettings?.subdlConnected ?? false

  async function connect() {
    const api = window.api?.mediaHub
    if (!api || !apiKey.trim()) return
    setStatus({ kind: 'busy' })
    try {
      const result = await api.subdl.connect(apiKey.trim())
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
    await api.subdl.disconnect().catch(() => {})
    setStatus({ kind: 'idle' })
    refreshMediaHubSettings()
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-subdl">
      <div className={styles.serviceHead}>
        <h2 id="settings-subdl" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          SubDL
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Subtitle search inside the player, with no daily download limit. Get a free key at
        subdl.com/panel/api — it is searched first when connected, so OpenSubtitles&apos; small free
        download quota is only spent when SubDL has no match.
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
              <span className={styles.fieldLabel}>SubDL API Key</span>
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
        Subtitle search inside the player, for titles without embedded subtitle tracks. A free
        account allows 5 subtitle downloads per day (1000 with their paid VIP), so connect SubDL
        above as well — it is searched first and has no download limit.
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
              <span className={styles.fieldLabel}>Username</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password</span>
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
              // OpenSubtitles' download endpoint (unlike search) requires a
              // real logged-in session — see subtitlesService.ts's
              // osLoginWith — so all three fields are genuinely required,
              // not just the API key. These used to be labeled "(optional)"
              // while the backend rejected a connect attempt without them
              // every time; fixed by requiring what's actually required
              // instead of promising less than that.
              disabled={
                !apiKey.trim() || !username.trim() || !password.trim() || status.kind === 'busy'
              }
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
  const {
    partyStatus,
    partyHostCode,
    mediaHubSettings,
    refreshMediaHubSettings,
    hostParty,
    joinParty,
    leaveParty
  } = useAppState()
  const [nameEdited, setNameEdited] = useState<string | null>(null)
  const name = nameEdited ?? mediaHubSettings?.partyDisplayName ?? ''
  const [joinCode, setJoinCode] = useState('')
  const [mode, setMode] = useState<PartyMode>('direct')
  const [actionStatus, setActionStatus] = useState<Status>({ kind: 'idle' })
  const relayReady = mediaHubSettings?.partySyncConnected ?? false

  function rememberName(value: string): void {
    window.api?.mediaHub?.settings.setPartyDisplayName(value).then(() => refreshMediaHubSettings())
  }

  async function host() {
    if (!name.trim()) return
    setActionStatus({ kind: 'busy' })
    try {
      await hostParty(name.trim(), relayReady ? mode : 'direct')
      rememberName(name.trim())
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
      rememberName(name.trim())
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
                onChange={(e) => setNameEdited(e.target.value)}
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

/**
 * The local AI model everything in this app labelled "AI" runs on.
 *
 * Ollama rather than a hosted API on purpose: the app has no account, no
 * key of its own to spend, and nothing here should be sending someone's
 * viewing habits to a service they didn't choose. The model is one they
 * installed on their own machine, and if they haven't installed one, the
 * AI features say so instead of quietly doing something else.
 *
 * Two steps, deliberately: check the address first (which lists what is
 * actually installed there), then pick from that list. Typing a model name
 * blind is how you end up with a setting that saves fine and fails later at
 * the point of use.
 */
export function OllamaSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const savedBaseUrl = mediaHubSettings?.ollamaBaseUrl ?? ''
  const savedModel = mediaHubSettings?.ollamaModel ?? ''
  const connected = mediaHubSettings?.ollamaConnected ?? false

  const [baseUrlEdited, setBaseUrlEdited] = useState<string | null>(null)
  const baseUrl = baseUrlEdited ?? savedBaseUrl
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Whether a write — Connect or Disconnect — is in flight, tracked apart
  // from the probe lifecycle below.
  //
  // The two are genuinely different things and conflating them was a bug:
  // editing the address while a slow Connect was still checking the host
  // called abandonProbe(), which cleared the shared status back to idle and
  // re-enabled the Connect button, so a second Connect could start and race
  // the first to persist a different server. A probe can be abandoned
  // because nobody wants its answer any more; a write cannot, because it is
  // going to happen whether or not the form has moved on.
  const [saving, setSaving] = useState(false)
  // Both fields are frozen while a write is in flight, which is what makes
  // that safe: there is no edit to lose, and connect()'s own
  // setBaseUrlEdited(null) on success cannot discard one made meanwhile.
  const busy = saving || status.kind === 'busy'

  // Every probe of a server claims a number, and only the newest one's
  // result is allowed to land.
  //
  // A probe can take the full six seconds against a host that never answers,
  // which is long enough for someone to give up, type a different address
  // and press Check. Without this, the slow first result arrives last and
  // overwrites the second server's model list: the field shows one server,
  // the dropdown lists another's models, and Connect then fails on a model
  // the address in the box has never heard of. Editing the address bumps it
  // too — a probe in flight was asking about somewhere else.
  const probeGeneration = useRef(0)

  /**
   * Invalidates a probe still in flight along with everything it told us:
   * the model list, the selection made from it, and the message describing
   * it.
   *
   * The list has to go with it. That dropdown is a claim about the server in
   * the address field — "these are the models installed there" — and the
   * moment the address changes, nothing has verified that claim. Leaving it
   * lets someone submit a model the new server never listed and collect an
   * avoidable failure, and it is the same species of unearned claim the rest
   * of this work went round removing. Clearing it empties the selection too,
   * which disables Connect until Check has actually asked the new address
   * what it has — which is the right order to do this in.
   */
  /**
   * The one way the model list and the selection ever change, so they cannot
   * come apart.
   *
   * They already have, twice. The selection kept a model the server no
   * longer had; then the early returns in check() — unreachable, or reached
   * with nothing installed — emptied the list and left the selection behind,
   * so Connect stayed enabled on a model the latest probe had explicitly not
   * verified. Both were the same invariant written down in more than one
   * place: what is selected must be something the last probe actually saw.
   * pickInstalledModel returns '' for an empty list, so "we learned nothing"
   * lands here as "select nothing" without a special case.
   */
  function applyProbedModels(installed: string[], saved = '') {
    // Keeps the array identity when nothing was there and nothing is now —
    // this runs on every keystroke in the address field via abandonProbe.
    setModels((current) => (current.length === 0 && installed.length === 0 ? current : installed))
    setModel((current) => pickInstalledModel(installed, current, saved))
  }

  function abandonProbe() {
    probeGeneration.current += 1
    applyProbedModels([])
    // Must not be left on 'busy': that disables Check and Connect, and the
    // superseded probe is no longer coming back to clear it. A write in
    // flight owns the status line and is exempt — clearing it there would
    // re-enable Connect underneath a Connect that is still running.
    if (!saving) setStatus({ kind: 'idle' })
  }

  // Populates the model list on open when there is already an address to
  // check, so a connected instance shows its models without anyone having
  // to press Check first. Keyed on the SAVED address only — re-probing on
  // every keystroke while someone types a new one would fire a request per
  // character.
  useEffect(() => {
    const api = window.api?.mediaHub?.ollama
    if (!api || !savedBaseUrl) return
    const generation = ++probeGeneration.current
    api
      .status()
      .then((result) => {
        if (probeGeneration.current !== generation) return
        // The saved model is only a preference, never a guarantee — it can
        // have been removed with `ollama rm` since it was configured.
        applyProbedModels(result.models, result.model)
      })
      .catch(() => {})
    return () => {
      probeGeneration.current += 1
    }
  }, [savedBaseUrl])

  async function check() {
    const api = window.api?.mediaHub?.ollama
    if (!api || saving) return
    const generation = ++probeGeneration.current
    // Check is always a question about what is IN the field. Passing an
    // empty address through as `undefined` made the bridge omit it, which
    // main reads as "probe whatever is saved" — so clearing the box and
    // pressing Check reported success and repopulated the old server's
    // models while showing an empty address. The no-argument form is for the
    // probe on open, which really is asking about the saved server.
    const address = baseUrl.trim()
    if (!address) {
      applyProbedModels([])
      setStatus({
        kind: 'error',
        message: `Enter the address of your Ollama server, e.g. ${DEFAULT_OLLAMA_BASE_URL}`
      })
      return
    }
    setStatus({ kind: 'busy' })
    const result = await api.status(address).catch(() => null)
    // Superseded by a newer check, or by the address being edited while this
    // one was out. Whatever replaced it owns the status line now.
    if (probeGeneration.current !== generation) return
    if (!result) {
      applyProbedModels([])
      setStatus({ kind: 'error', message: 'Could not check that address.' })
      return
    }
    // Before the early returns below, not after: an unreachable server and a
    // server with nothing installed both report no models, and the selection
    // has to go with them. No saved model is passed, because Check may be
    // probing a different address from the one the settings file describes.
    applyProbedModels(result.models)
    if (!result.reachable) {
      setStatus({ kind: 'error', message: result.error ?? 'No Ollama server answered there.' })
      return
    }
    if (!result.models.length) {
      setStatus({
        kind: 'error',
        message:
          'Reached Ollama, but it has no models installed. Pull one first, e.g. "ollama pull llama3.2".'
      })
      return
    }
    setStatus({
      kind: 'ok',
      message: `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'}.`
    })
  }

  async function connect() {
    const api = window.api?.mediaHub?.ollama
    if (!api || !baseUrl.trim() || !model || saving) return
    // Connect's own outcome is the message that matters — a probe still in
    // flight must not overwrite "Connected." with "Found 3 models."
    probeGeneration.current += 1
    setSaving(true)
    setStatus({ kind: 'busy' })
    try {
      await api.connect(baseUrl.trim(), model)
      setBaseUrlEdited(null)
      setStatus({ kind: 'ok', message: 'Connected.' })
      refreshMediaHubSettings()
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not connect.'
      })
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    const api = window.api?.mediaHub?.ollama
    if (!api || saving) return
    probeGeneration.current += 1
    setSaving(true)
    setStatus({ kind: 'busy' })
    try {
      await api.disconnect().catch(() => {})
      setBaseUrlEdited(null)
      setStatus({ kind: 'idle' })
      refreshMediaHubSettings()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-ollama">
      <div className={styles.serviceHead}>
        <h2 id="settings-ollama" className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          Local AI model
        </h2>
        <ConnectionBadge connected={connected} />
      </div>
      <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
        Point R3 at an Ollama instance running on this machine (or another one on your network) and
        the AI features run on that model: the &ldquo;Ask R3 anything&rdquo; field answers from it,
        and the Recommend Next buttons let it choose. Nothing is sent anywhere else. With nothing
        connected, the assistant says so rather than making something up, and the Recommend Next
        buttons keep working by picking at random — labelled as a random pick, never passed off as a
        recommendation. Install from ollama.com, then <code>ollama pull llama3.2</code>.
      </p>

      {connected && (
        <p className={styles.rowDescription} style={{ marginBottom: 10 }}>
          Currently asking <strong>{savedModel}</strong> at <strong>{savedBaseUrl}</strong>.
        </p>
      )}

      <div className={styles.serviceFields}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Server address</span>
          <input
            className={styles.fieldInput}
            type="text"
            placeholder={DEFAULT_OLLAMA_BASE_URL}
            value={baseUrl}
            onChange={(e) => {
              // Anything still being probed was asking about the previous
              // address — see abandonProbe.
              abandonProbe()
              setBaseUrlEdited(e.target.value)
            }}
            // Frozen while Connect/Disconnect is writing: that request is
            // about the address as it stands, and an edit landing underneath
            // it would either be discarded on success or persist a server
            // nobody asked for.
            disabled={saving}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Model</span>
          <select
            className={`${styles.fieldInput} ${styles.fieldSelect}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!models.length || saving}
          >
            {models.length ? (
              models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))
            ) : (
              <option value="">Check the address first</option>
            )}
          </select>
        </label>
      </div>

      <div className={styles.serviceActions} style={{ marginTop: 10 }}>
        <button type="button" className={styles.testButton} onClick={check} disabled={busy}>
          <Icon name="refresh" size={12} /> Check
        </button>
        <button
          type="button"
          className={styles.testButton}
          onClick={connect}
          disabled={!baseUrl.trim() || !model || busy}
        >
          {connected ? 'Save' : 'Connect'}
        </button>
        {connected && (
          <button type="button" className={styles.testButton} onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        )}
        <StatusLine status={status} />
      </div>
    </section>
  )
}
