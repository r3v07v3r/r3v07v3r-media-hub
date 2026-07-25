import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DEFAULT_SERVICE_SETTINGS, ServiceSettings } from '@shared/ipc-types'
import { getTorrents, QbTorrent } from '@renderer/lib/api/qbittorrent'
import { sonarrClient, radarrClient, ServarrQueueItem } from '@renderer/lib/api/servarr'
import { isConfigured } from '@renderer/lib/api/types'
import { ComingSoonSection } from '@renderer/components/placeholder/ComingSoonSection'
import styles from './Downloads.module.css'

function formatBytes(n: number): string {
  if (!n) return '0 MB'
  const mb = n / 1024 / 1024
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

function TorrentRow({ t }: { t: QbTorrent }) {
  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <span>{t.name}</span>
        <span>{Math.round(t.progress * 100)}%</span>
      </div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${Math.round(t.progress * 100)}%` }}
        />
      </div>
      <span className={styles.itemMeta}>
        {t.state} · {formatBytes(t.size)} · ↓ {formatBytes(t.dlspeed)}/s
      </span>
    </div>
  )
}

function QueueRow({ q }: { q: ServarrQueueItem }) {
  const title = q.title ?? q.series?.title ?? q.movie?.title ?? 'Unknown'
  const pct =
    q.size && q.sizeleft !== undefined ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0
  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <span>{title}</span>
        <span>{q.status ?? q.trackedDownloadStatus ?? ''}</span>
      </div>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      {q.timeleft && <span className={styles.itemMeta}>{q.timeleft} remaining</span>}
    </div>
  )
}

/**
 * Real downloads dashboard — queries qBittorrent for active torrents and
 * Sonarr/Radarr for their download queues via the IPC-proxied clients in
 * lib/api. Falls back to the shared ComingSoonSection placeholder when
 * none of the three services are configured, rather than showing empty
 * panels with no explanation.
 */
export default function DownloadsPage() {
  const [settings, setSettings] = useState<ServiceSettings>(DEFAULT_SERVICE_SETTINGS)
  const [torrents, setTorrents] = useState<QbTorrent[]>([])
  const [torrentsLive, setTorrentsLive] = useState(false)
  const [sonarrQueue, setSonarrQueue] = useState<ServarrQueueItem[]>([])
  const [radarrQueue, setRadarrQueue] = useState<ServarrQueueItem[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!window.api?.settings) {
        setLoaded(true)
        return
      }
      const s = await window.api.settings.get()
      if (cancelled) return
      setSettings(s)

      const [qb, sonarr, radarr] = await Promise.all([
        getTorrents(s.qbittorrent),
        sonarrClient.getQueue(s.sonarr),
        radarrClient.getQueue(s.radarr)
      ])
      if (cancelled) return
      if (qb.ok) {
        setTorrents(qb.data ?? [])
        setTorrentsLive(qb.live)
      }
      if (sonarr.ok) setSonarrQueue(sonarr.data ?? [])
      if (radarr.ok) setRadarrQueue(radarr.data ?? [])
      setLoaded(true)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (!loaded) return null

  const anyConfigured =
    isConfigured(settings.qbittorrent) ||
    isConfigured(settings.sonarr) ||
    isConfigured(settings.radarr)

  if (!anyConfigured) {
    return (
      <ComingSoonSection
        icon="downloads"
        title="Downloads"
        description="Connect qBittorrent, Sonarr, or Radarr in Settings to see active downloads and queues here."
      />
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>Downloads</h1>

      {isConfigured(settings.qbittorrent) && (
        <section className={`${styles.section} glass-panel`}>
          <h2 className={styles.sectionTitle}>
            <span className={torrentsLive ? styles.liveDot : styles.mockDot} />
            qBittorrent
          </h2>
          {torrents.length === 0 ? (
            <p className={styles.empty}>No active torrents.</p>
          ) : (
            torrents.map((t) => <TorrentRow key={t.hash} t={t} />)
          )}
        </section>
      )}

      {isConfigured(settings.sonarr) && (
        <section className={`${styles.section} glass-panel`}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.liveDot} />
            Sonarr Queue
          </h2>
          {sonarrQueue.length === 0 ? (
            <p className={styles.empty}>Queue is empty.</p>
          ) : (
            sonarrQueue.map((q) => <QueueRow key={q.id} q={q} />)
          )}
        </section>
      )}

      {isConfigured(settings.radarr) && (
        <section className={`${styles.section} glass-panel`}>
          <h2 className={styles.sectionTitle}>
            <span className={styles.liveDot} />
            Radarr Queue
          </h2>
          {radarrQueue.length === 0 ? (
            <p className={styles.empty}>Queue is empty.</p>
          ) : (
            radarrQueue.map((q) => <QueueRow key={q.id} q={q} />)
          )}
        </section>
      )}

      <Link to="/settings" className={styles.configureLink}>
        Manage connections in Settings →
      </Link>
    </div>
  )
}
