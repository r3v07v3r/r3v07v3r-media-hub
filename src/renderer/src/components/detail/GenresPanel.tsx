'use client'

import styles from './GenresPanel.module.css'

// Deterministic hue spread — same technique categoryConfig.ts's
// genreBlobs() uses for GenreBlobRow, kept here as a small local copy
// rather than importing it since that helper was removed along with
// GenreBlobRow (see CategoryPage.tsx's history) and this is the only
// other place a genre chip needs a color identity.
function hueFor(index: number, total: number): number {
  return Math.round((360 / Math.max(total, 1)) * index)
}

export function GenresPanel({
  genres,
  onSelectGenre
}: {
  genres: string[]
  onSelectGenre: (genre: string) => void
}) {
  if (genres.length === 0) return null

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Genres">
      <h2 className={styles.heading}>Genres</h2>
      <div className={styles.chipRow}>
        {genres.map((g, i) => (
          <button
            key={g}
            type="button"
            className={styles.chip}
            style={{ ['--chip-hue' as string]: hueFor(i, genres.length) }}
            onClick={() => onSelectGenre(g)}
          >
            {g}
          </button>
        ))}
      </div>
    </section>
  )
}
