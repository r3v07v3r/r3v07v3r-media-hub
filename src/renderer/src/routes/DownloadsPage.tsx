import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StreamCacheEntry, StreamCacheUsage } from '@shared/media-hub/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { BackgroundActivitySection } from '@renderer/components/downloads/BackgroundActivitySection'
import { ComingSoonSection } from '@renderer/components/placeholder/ComingSoonSection'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Downloads.module.css'

/** How often the Cached Streams list re-polls while this page stays
 *  mounted — an active session keeps writing (cachedBytes growing) or can
 *  stop (isActive flipping) at any moment, so a single mount-time snapshot
 *  goes stale almost immediately if the person just leaves this page open.
 *  Cheap enough to poll this often: it's a local directory read, not a
 *  network call, unlike the qBittorrent/Sonarr/Radarr queries above. */
const CACHE_POLL_INTERVAL_MS = 4000

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

/**
 * Real downloads dashboard — queries qBittorrent for active torrents and
 * Sonarr/Radarr for their download queues via the IPC-proxied clients in
 * lib/api. Falls back to the shared ComingSoonSection placeholder when
 * none of the three services are configured, rather than showing empty
 * panels with no explanation.
 */
export default function DownloadsPage() {
  const { setControlCentreOpen } = useAppState()
  const [cacheEntries, setCacheEntries] = useState<StreamCacheEntry[]>([])
  const [usage, setUsage] = useState<StreamCacheUsage | null>(null)
  const [loaded, setLoaded] = useState(false)
  const openServices = (): void => setControlCentreOpen(true)

  // Two local reads and nothing else. This page used to open the mount by
  // querying qBittorrent, Sonarr, Radarr and Prowlarr over the network
  // before it could show anything — four services a viewer is not asking
  // about, any of which being slow or down delayed the shelf they were.
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const api = window.api?.mediaHub
      if (!api) {
        setLoaded(true)
        return
      }
      const [cache, space] = await Promise.all([
        api.streamCache.list().catch(() => [] as StreamCacheEntry[]),
        api.streamCache.usage().catch(() => null)
      ])
      if (cancelled) return
      setCacheEntries(cache ?? [])
      setUsage(space)
      setLoaded(true)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // Keeps cachedBytes/isActive fresh while this page stays open — see
  // CACHE_POLL_INTERVAL_MS's own comment on why a one-time snapshot isn't
  // enough. The space figure comes with it: a title finishing its download
  // moves both numbers, and showing one without the other invites the
  // question of which is stale.
  useEffect(() => {
    if (!window.api?.mediaHub) return
    const id = setInterval(() => {
      const api = window.api?.mediaHub
      if (!api) return
      void api.streamCache
        .list()
        .then(setCacheEntries)
        .catch(() => {
          // Best-effort — leaves the list exactly as it was until the next tick.
        })
      void api.streamCache
        .usage()
        .then(setUsage)
        .catch(() => {
          // Same: last known figure beats a blank.
        })
    }, CACHE_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const handleDeleteCacheEntry = (token: string): void => {
    setCacheEntries((prev) => prev.filter((e) => e.token !== token))
    window.api?.mediaHub.streamCache.delete(token).catch(() => {
      // Best-effort — a failed delete just leaves the row absent from this
      // page's list until the next reload re-syncs it from disk.
    })
  }

  if (!loaded) return null

  // Empty means empty, and says the useful thing rather than sending
  // somebody off to connect a download client. Nothing here needs one:
  // what this page lists is what playing a title left on the disk.
  if (cacheEntries.length === 0) {
    return (
      <div className={styles.wrap}>
        <BackgroundActivitySection />
        <ComingSoonSection
          icon="downloads"
          title="Nothing saved yet"
          description="Titles you play are kept on this device so you can rewind, resume, and watch them again without a connection. They will appear here."
        />
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>Downloads</h1>
      {/* ONE figure, not a breakdown. What is on this device and what is
          left on the drive holding it answers "can I keep another film?",
          which is the only storage question this page needs to answer.
          Everything finer — per-session bytes, the budget, eviction — is
          in the control centre. */}
      {usage && (
        <p className={styles.spaceLine}>
          {formatBytes(usage.usedBytes)} saved on this device
          {usage.freeBytes !== null ? ` · ${formatBytes(usage.freeBytes)} free` : ''}
        </p>
      )}

      <BackgroundActivitySection />

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

      {/* The download clients, indexers and the Sonarr/Radarr queues used
          to be listed below this. They are the machinery, not the shelf —
          somebody looking at Downloads wants to know what they can watch
          on a train, and every one of those sections is already in the
          control centre's Services view with its own controls. */}
      <button type="button" className={styles.configureLink} onClick={openServices}>
        Download clients and queues are in the control centre →
      </button>
    </div>
  )
}
