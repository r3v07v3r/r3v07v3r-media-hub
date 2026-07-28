import { Link } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { ComingSoonSection } from '@renderer/components/placeholder/ComingSoonSection'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { WatchStatusBadge } from '@renderer/components/media/WatchStatusBadge'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import styles from './MyStuff.module.css'

export default function MyStuffPage() {
  const { myList, toggleMyList, openDetail, catalog, continueWatching } = useAppState()
  const items = catalog.filter((m) => myList.has(m.id))
  useRestoreBrowsingOrigin(true)

  if (items.length === 0) {
    return (
      <ComingSoonSection
        icon="mystuff"
        title="My Stuff"
        description="Titles you save with “My List” will show up here. Nothing saved yet — try adding something from the Home dashboard."
      />
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>My Stuff</h1>
      <div className={styles.grid}>
        {items.map((m) => {
          const artwork = resolveArtwork(m)
          const watchStatus = getWatchStatus(m, continueWatching)
          return (
            <div key={m.id} className={styles.card}>
              <button
                type="button"
                className={styles.art}
                data-media-id={m.id}
                onClick={() => openDetail(m)}
              >
                <ArtworkImage
                  src={artwork.posterUrl ?? artwork.backdropUrl}
                  alt=""
                  fallbackTitle={m.title}
                  artTint={m.artTint}
                  sizes="160px"
                  className={styles.artImage}
                />
                <WatchStatusBadge status={watchStatus} />
              </button>
              <div className={styles.info}>
                <span className={styles.title}>{m.title}</span>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => toggleMyList(m)}
                  aria-label={`Remove ${m.title} from My List`}
                >
                  <Icon name="x" size={12} />
                  Remove
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <Link to="/" className={styles.backLink}>
        ← Back to Home
      </Link>
    </div>
  )
}
