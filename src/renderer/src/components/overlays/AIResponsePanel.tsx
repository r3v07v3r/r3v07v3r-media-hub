'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { resolveArtwork } from '@renderer/lib/artwork'
import type { MediaItem } from '@renderer/types'
import styles from './Overlays.module.css'

const KIND_LABEL: Record<string, string> = {
  movie: 'Movie',
  series: 'Series',
  anime: 'Anime',
  episode: 'Series',
  live: 'Movie'
}

/** One title, as a thing you can open. */
function TitleTile({ media, onOpen }: { media: MediaItem; onOpen: (media: MediaItem) => void }) {
  const artwork = resolveArtwork(media)
  return (
    <li>
      <button
        type="button"
        className={styles.aiTile}
        data-media-id={media.id}
        onClick={() => onOpen(media)}
      >
        <ArtworkImage
          src={artwork.posterUrl ?? artwork.thumbnailUrl}
          alt=""
          fallbackTitle={media.title}
          artTint={media.artTint}
          className={styles.aiTilePoster}
        />
        <span className={styles.aiTileTitle}>{media.title}</span>
        <span className={styles.aiTileMeta}>
          {[KIND_LABEL[media.mediaType] ?? '', media.releaseYear || ''].filter(Boolean).join(' · ')}
        </span>
      </button>
    </li>
  )
}

/** Three empty tiles while the catalog is still being searched, so the row does not pop into existence under the answer. */
function TileSkeletons() {
  return (
    <ul className={styles.aiTiles} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i}>
          <span className={styles.aiTilePending} />
        </li>
      ))}
    </ul>
  )
}

/**
 * What the assistant field answers with.
 *
 * Two things, in this order and for a reason. First the titles the app's
 * own catalog search found — real rows with posters, openable, and there
 * whether or not a model is connected, because "which film is that" is a
 * question this app can answer by itself. Then whatever the model made of
 * them: a few sentences grounded in what has actually been watched, and a
 * row of other titles it named, each one looked up so it opens like
 * anything else in the app.
 *
 * Before this, the panel was prose and nothing else — an answer that could
 * have come from any chat box, in an app that was holding the film the
 * question was about.
 */
export function AIResponsePanel() {
  const {
    assistantState,
    assistantResponse,
    assistantResults,
    assistantSimilar,
    assistantSimilarSource,
    assistantSearching,
    closeAssistant,
    openDetail
  } = useAppState()

  // 'error' shows too: a local model that isn't connected, isn't running,
  // or timed out puts its reason in assistantResponse, and that reason is
  // the whole point — silently rendering nothing would look like the field
  // ignored the question.
  if (
    assistantState !== 'processing' &&
    assistantState !== 'responding' &&
    assistantState !== 'error'
  ) {
    return null
  }

  // Opening a title ends the answer. The panel is fixed to the top of the
  // window, so leaving it up would park it over the detail page the person
  // just asked to see — and it would still be holding a model generating
  // for a question they have moved on from.
  function open(media: MediaItem) {
    closeAssistant()
    openDetail(media)
  }

  const thinking = assistantState === 'processing'

  return (
    <div className={`${styles.aiPanel} glass-panel`}>
      <span className={styles.aiPanelIcon}>
        <Icon name={assistantState === 'error' ? 'info' : 'sparkle'} />
      </span>

      <div className={styles.aiPanelBody}>
        {(assistantSearching || assistantResults.length > 0) && (
          <section className={styles.aiSection}>
            <h2 className={styles.aiSectionHeading}>In R3</h2>
            {assistantSearching ? (
              <TileSkeletons />
            ) : (
              <ul className={styles.aiTiles}>
                {assistantResults.map((media) => (
                  <TitleTile key={media.id} media={media} onOpen={open} />
                ))}
              </ul>
            )}
          </section>
        )}

        <div className={styles.aiPanelText} role="status" aria-live="polite">
          {thinking ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className={styles.skeletonLine} style={{ width: '80%' }} />
              <span className={styles.skeletonLine} style={{ width: '55%' }} />
            </div>
          ) : (
            assistantResponse
          )}
        </div>

        {assistantSimilar.length > 0 && (
          <section className={styles.aiSection}>
            {/* Which of the two this is, said plainly. A model's suggestion
                is about you; the catalog's related titles are about the
                first result and nothing else, and passing the second off as
                the first is the sort of small lie the Recommend Next
                buttons already refuse to tell. */}
            <h2 className={styles.aiSectionHeading}>
              {assistantSimilarSource === 'model'
                ? 'Also suggested'
                : `More like ${assistantResults[0]?.title ?? 'this'}`}
            </h2>
            <ul className={styles.aiTiles}>
              {assistantSimilar.map((media) => (
                <TitleTile key={media.id} media={media} onOpen={open} />
              ))}
            </ul>
          </section>
        )}
      </div>

      <button
        type="button"
        className={styles.aiPanelClose}
        onClick={closeAssistant}
        aria-label="Dismiss response"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}
