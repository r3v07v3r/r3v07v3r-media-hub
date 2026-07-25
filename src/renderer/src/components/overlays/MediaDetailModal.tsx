'use client'

import { useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

export function MediaDetailModal() {
  const { detailMedia, closeDetail, startPlayback, myList, toggleMyList } = useAppState()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!detailMedia) return
    closeRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detailMedia, closeDetail])

  if (!detailMedia) return null
  const saved = myList.has(detailMedia.id)

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeDetail()
      }}
    >
      <div className={`${styles.modal} glass-panel`}>
        <div
          className={styles.modalArt}
          style={{
            background: `linear-gradient(135deg, ${detailMedia.artTint[0]}, ${detailMedia.artTint[1]})`
          }}
        >
          <button
            ref={closeRef}
            type="button"
            className={styles.closeButton}
            onClick={closeDetail}
            aria-label="Close details"
          >
            <Icon name="x" size={16} />
          </button>
          <h2 id="detail-modal-title" className={styles.modalArtTitle}>
            {detailMedia.title}
            {detailMedia.subtitle ? ` — ${detailMedia.subtitle}` : ''}
          </h2>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.metaRow}>
            {detailMedia.releaseYear && <span>{detailMedia.releaseYear}</span>}
            {detailMedia.seasonNumber && (
              <span>
                S{detailMedia.seasonNumber} · Ep {detailMedia.episodeNumber}
              </span>
            )}
            {detailMedia.runtimeMinutes && <span>{detailMedia.runtimeMinutes}m</span>}
            {detailMedia.communityRating && (
              <span className={styles.metaRating}>
                <Icon name="star" /> {detailMedia.communityRating.toFixed(1)}
              </span>
            )}
            {detailMedia.imdbRating && <span>IMDb {detailMedia.imdbRating.toFixed(1)}</span>}
            {detailMedia.matchPercentage && (
              <span style={{ color: 'var(--accent-green)' }}>
                {detailMedia.matchPercentage}% Match
              </span>
            )}
          </div>
          <div className={styles.metaRow}>
            {detailMedia.genres.map((g) => (
              <span key={g} className={styles.genreChip}>
                {g}
              </span>
            ))}
          </div>
          <p className={styles.description}>
            {detailMedia.description ||
              `An acclaimed ${detailMedia.mediaType} in ${detailMedia.genres.join(
                ', '
              )}. Details are pulled from your library metadata once connected to a real catalog.`}
          </p>
          <div className={styles.actions}>
            <PrimaryButton onClick={() => startPlayback(detailMedia)} />
            <SecondaryButton saved={saved} onClick={() => toggleMyList(detailMedia.id)} />
          </div>
        </div>
      </div>
    </div>
  )
}

function PrimaryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 22px',
        borderRadius: 999,
        background: 'linear-gradient(135deg, var(--accent-blue), var(--accent-violet))',
        color: '#fff',
        fontWeight: 600,
        fontSize: 14,
        boxShadow: '0 8px 26px -8px rgba(94,140,255,0.7)',
        minHeight: 44
      }}
    >
      <Icon name="play" size={15} />
      Watch Now
    </button>
  )
}

function SecondaryButton({ saved, onClick }: { saved: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={saved}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 20px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
        fontWeight: 500,
        fontSize: 14,
        minHeight: 44
      }}
    >
      <Icon name={saved ? 'check' : 'plus'} size={15} />
      {saved ? 'In My List' : 'My List'}
    </button>
  )
}
