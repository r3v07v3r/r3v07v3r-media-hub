import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DEFAULT_SERVICE_SETTINGS, ServiceSettings } from '@shared/ipc-types'
import type { StreamCacheEntry } from '@shared/media-hub/types'
import { getTorrents, QbTorrent } from '@renderer/lib/api/qbittorrent'
import { sonarrClient, radarrClient, ServarrQueueItem } from '@renderer/lib/api/servarr'
import { isConfigured } from '@renderer/lib/api/types'
import { ComingSoonSection } from '@renderer/components/placeholder/ComingSoonSection'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Downloads.module.css'

function formatBytes(n: number): string {
  if (!n) return '0 MB'
  const mb = n / 1024 / 1024
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

/** Mirrors AppStateContext.tsx's mediaKindToDetailPath — this page only has
 *  the bare catalogId/mediaKind from the cache manifest, not a full
 *  MediaItem, so it can't reuse that helper (or openDetail) directly. */
function cacheEntryDetailPath(entry: StreamCacheEntry): string | null {
  if (!entry.catalogId || !entry.mediaKind) return null
  const segment = entry.mediaKind === 'movie' ? 'movies' : entry.mediaKind
  return `/${segment}/${entry.catalogId}`
}

function CacheStreamRow({
  entry,
  onDelete
}: {
  entry: StreamCacheEntry
  onDelete: (token: string) => void
}) {
  const navigate = useNavigate()
  const detailPath = cacheEntryDetailPath(entry)
  const pct =
    entry.totalBytes && entry.totalBytes > 0
      ? Math.min(100, Math.round((entry.cachedBytes / entry.totalBytes) * 100))
      : null
  const sizeLabel = entry.totalBytes
    ? `${formatBytes(entry.cachedBytes)} of ${formatBytes(entry.totalBytes)}`
    : formatBytes(entry.cachedBytes)

  return (
    <div className={`${styles.item} ${styles.cacheItem}`}>
      <div className={styles.cachePoster}>
        {entry.posterUrl ? <img src={entry.posterUrl} alt="" /> : null}
      </div>
      <div className={styles.cacheBody}>
        <div className={styles.itemHead}>
          <span>{entry.title}</span>
          {entry.isActive && <span className={styles.playingBadge}>Playing now</span>}
        </div>
        {entry.seasonNumber && (
          <span className={styles.itemMeta}>
            S{entry.seasonNumber} · Ep {entry.episodeNumber}
          </span>
        )}
        {pct !== null && (
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
        <span className={styles.itemMeta}>{sizeLabel}</span>
      </div>
      {!entry.isActive && (
        <div className={styles.cacheActions}>
          {detailPath && (
            <button
              type="button"
              className={styles.cacheActionButton}
              onClick={() => navigate(detailPath)}
              aria-label={`Watch ${entry.title}`}
            >
              <Icon name="play" />
            </button>
          )}
          <button
            type="button"
            className={styles.cacheActionButton}
            onClick={() => onDelete(entry.token)}
            aria-label={`Delete cached copy of ${entry.title}`}
          >
            <Icon name="trash" />
          </button>
        </div>
      )}
    </div>
  )
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
  const [cacheEntries, setCacheEntries] = useState<StreamCacheEntry[]>([])
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

      const [qb, sonarr, radarr, cache] = await Promise.all([
        getTorrents(s.qbittorrent),
        sonarrClient.getQueue(s.sonarr),
        radarrClient.getQueue(s.radarr),
        window.api.mediaHub.streamCache.list().catch(() => [] as StreamCacheEntry[])
      ])
      if (cancelled) return
      if (qb.ok) {
        setTorrents(qb.data ?? [])
        setTorrentsLive(qb.live)
      }
      if (sonarr.ok) setSonarrQueue(sonarr.data ?? [])
      if (radarr.ok) setRadarrQueue(radarr.data ?? [])
      setCacheEntries(cache ?? [])
      setLoaded(true)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleDeleteCacheEntry = (token: string): void => {
    setCacheEntries((prev) => prev.filter((e) => e.token !== token))
    window.api?.mediaHub.streamCache.delete(token).catch(() => {
      // Best-effort — a failed delete just leaves the row absent from this
      // page's list until the next reload re-syncs it from disk.
    })
  }

  if (!loaded) return null

  const anyConfigured =
    isConfigured(settings.qbittorrent) ||
    isConfigured(settings.sonarr) ||
    isConfigured(settings.radarr)

  if (!anyConfigured && cacheEntries.length === 0) {
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

      <section className={`${styles.section} glass-panel`}>
        <h2 className={styles.sectionTitle}>
          <span className={styles.liveDot} />
          Cached Streams
        </h2>
        {cacheEntries.length === 0 ? (
          <p className={styles.empty}>Nothing cached locally right now.</p>
        ) : (
          cacheEntries.map((entry) => (
            <CacheStreamRow key={entry.token} entry={entry} onDelete={handleDeleteCacheEntry} />
          ))
        )}
      </section>

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
