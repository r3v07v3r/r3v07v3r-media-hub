import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Settings.module.css'

// The Cache Server card: pairing with an r3-cache daemon (tier 2 of the
// playback source order) and its live status.
//
// The zero-config story made visible: Discover lists daemons announcing
// themselves on the LAN, and picking one (or typing a URL, for networks
// that filter multicast) asks to join. There is no code to read off a
// console any more — the server's administrator approves the request from
// their own app, which is the same authority without the walk to the
// machine. The full picture, including that administration, lives in the
// control centre's Caching section; this card is the standalone settings
// route's short version.
//
// The TorBox checkbox is the one real trust decision — an explicit copy of
// the account credential to another machine — so it is a checkbox at
// joining time, never a silent default.

interface DiscoveredDaemon {
  name: string
  host: string
  port: number
  url: string
}

interface DaemonStatus {
  serverName: string
  usedBytes: number
  budgetBytes: number
  itemCount: number
  /** Whether THIS device's TorBox account is linked on the daemon. */
  torboxLinked: boolean
  /** Household total of devices that linked an account. */
  linkedDevices: number
  activeStreams: number
  updater: { staged: string; latestSeen: string; lastError: string }
  jobs: Array<{ title: string; state: string; progressBytes: number; sizeBytes?: number }>
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function LanCacheSection() {
  const [paired, setPaired] = useState<string | null>(null)
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [daemons, setDaemons] = useState<DiscoveredDaemon[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [url, setUrl] = useState('')
  const [shareTorbox, setShareTorbox] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const api = window.api?.mediaHub?.lanCache

  const refresh = useCallback(async () => {
    if (!api) return
    const result = await api.status()
    if (result.connected && result.status) {
      setStatus(result.status as DaemonStatus)
      setStatusError('')
    } else if (result.connected) {
      setStatus(null)
      setStatusError(result.error ?? 'The cache server did not answer.')
    } else {
      setStatus(null)
      setStatusError('')
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    // Same shape as MediaServicesSection's load effect: always resolve
    // through a microtask so no setState lands synchronously in the
    // effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(async () => {
      const found = await api.discover()
      setPaired(found.paired)
      setDaemons(found.daemons)
      await refresh()
    })
  }, [api, refresh])

  if (!api) return null

  async function handleDiscover() {
    if (!api) return
    setDiscovering(true)
    const found = await api.discover()
    setDaemons(found.daemons)
    setPaired(found.paired)
    setDiscovering(false)
    if (!found.daemons.length) {
      setMessage({
        ok: false,
        text: 'No cache server answered. It may be off, or this network may block discovery — enter its URL below instead.'
      })
    }
  }

  async function handlePair(targetUrl: string) {
    if (!api) return
    setBusy(true)
    setMessage(null)
    const result = await api.pair({ url: targetUrl, shareTorboxToken: shareTorbox })
    setMessage({ ok: result.ok, text: result.message })
    setBusy(false)
    if (result.ok) {
      const found = await api.discover()
      setPaired(found.paired)
      void refresh()
    }
  }

  async function handleUnpair() {
    if (!api) return
    setBusy(true)
    await api.unpair()
    setPaired(null)
    setStatus(null)
    setMessage({ ok: true, text: 'Unpaired. The server keeps its files until they expire.' })
    setBusy(false)
  }

  const fetching = status?.jobs.filter((job) => job.state === 'fetching') ?? []

  return (
    <section className={`${styles.section} ${styles.serviceCard} glass-panel`}>
      <div className={styles.serviceHead}>
        <h3 className={styles.serviceName}>Cache server</h3>
      </div>
      <p className={styles.serviceNote}>
        A small server on your own network that downloads what you plan to watch ahead of time, so
        playback starts from one LAN hop instead of a slow internet link. Run r3-cache on any
        Windows or Linux box and ask to join it here. Everything it stores
        expires on its own — nothing stays forever.
      </p>

      {paired && (
        <>
          <div className={styles.row}>
            <div className={styles.rowIcon} aria-hidden="true">
              <Icon name="downloads" size={17} />
            </div>
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>{status?.serverName ?? 'Paired'}</span>
              <span className={styles.rowDescription}>
                {statusError
                  ? `${paired} — unreachable right now (${statusError})`
                  : status
                    ? `${paired} — ${status.itemCount} title${status.itemCount === 1 ? '' : 's'}, ${gb(status.usedBytes)} of ${gb(status.budgetBytes)} used${status.torboxLinked ? ', your account linked' : ', your account not linked'}${status.linkedDevices > 1 ? ` (${status.linkedDevices} people)` : ''}${fetching.length ? ` — fetching “${fetching[0].title}”` : ''}${status.updater?.staged ? ` — update ${status.updater.staged} ready, applies when idle` : ''}`
                    : paired}
              </span>
            </div>
            <button
              type="button"
              className={styles.testButton}
              onClick={handleUnpair}
              disabled={busy}
            >
              Unpair
            </button>
          </div>
        </>
      )}

      {!paired && (
        <>
          {daemons.length > 0 && (
            <div className={styles.serviceFields}>
              {daemons.map((daemon) => (
                <div key={daemon.url} className={styles.row}>
                  <div className={styles.rowText}>
                    <span className={styles.rowTitle}>{daemon.name}</span>
                    <span className={styles.rowDescription}>{daemon.url}</span>
                  </div>
                  <button
                    type="button"
                    className={styles.testButton}
                    onClick={() => handlePair(daemon.url)}
                    disabled={busy}
                  >
                    Ask to join
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={styles.serviceFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Server URL (if not discovered)</span>
              <input
                className={styles.fieldInput}
                type="text"
                placeholder="http://192.168.1.20:8945"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
          </div>
          <label className={styles.serviceNote}>
            <input
              type="checkbox"
              checked={shareTorbox}
              onChange={(event) => setShareTorbox(event.target.checked)}
            />{' '}
            Allow this server to download with my TorBox account. Your key is copied to that machine
            (protected by file permissions, not an OS keychain) so YOUR titles can be fetched
            overnight with the app closed. Each person who pairs shares their own account, and every
            download uses the account of whoever asked for that title. Unpairing revokes yours.
          </label>
          <div className={styles.serviceActions}>
            <button
              type="button"
              className={styles.testButton}
              onClick={handleDiscover}
              disabled={discovering}
            >
              {discovering ? 'Searching…' : 'Discover'}
            </button>
            <button
              type="button"
              className={styles.testButton}
              onClick={() => handlePair(url)}
              disabled={busy || !url.trim()}
            >
              {busy ? 'Asking…' : 'Ask to join'}
            </button>
          </div>
        </>
      )}

      {message && (
        <span
          className={`${styles.statusMessage} ${message.ok ? styles.statusOk : styles.statusError}`}
        >
          {message.text}
        </span>
      )}
    </section>
  )
}
