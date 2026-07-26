'use client'

// Bottom genre-filter row for the Movies/Series/Anime category pages —
// "large glowing organic blob buttons" per the integration spec, reusing
// MoodBrowser's exact pill/halo/glow CSS (same module, imported directly —
// not copied) rather than a second hand-rolled version of the same visual
// treatment, including the "flows under the left nav" bleed (.section's
// negative margin-left, keyed off the same --nav-rail-width variable the
// real nav rail sets) so these behave like a direct sibling of Home's mood
// row rather than a new one-off pattern.
//
// Deliberately its own (simpler) component rather than a MoodBrowser prop:
// MoodBrowser supports multi-select combining (shift-click) plus a
// floating filtered-results preview drawer, because Home has nowhere else
// to show mood matches. A category page already has a whole content area
// that re-renders against the active filter (see CategoryPage.tsx), so
// this row only needs single-select toggle — no drawer, no combine.

import { GenreBlob } from '@renderer/lib/mediaHub/categoryConfig'
import { Icon } from '@renderer/components/icons/Icon'
import moodStyles from '@renderer/components/home/MoodBrowser.module.css'

export interface GenreBlobRowProps {
  genres: GenreBlob[]
  activeGenre: string | null
  onSelect: (genreId: string | null) => void
}

// Best-effort keyword -> existing-icon mapping (same spirit as
// adapters.ts's GENRE_MOOD_KEYWORDS) so each blob gets a fitting glyph
// from this app's existing icon set rather than every pill sharing one
// generic sparkle — approximate, not a claim of editorial genre iconography.
const GENRE_ICON_KEYWORDS: [needle: string, icon: string][] = [
  ['action', 'lightning'],
  ['shonen', 'lightning'],
  ['thriller', 'pulse'],
  ['crime', 'pulse'],
  ['sci-fi', 'planet'],
  ['mecha', 'cpu'],
  ['romance', 'heart'],
  ['drama', 'heart'],
  ['comedy', 'smiley'],
  ['slice of life', 'people'],
  ['documentary', 'people'],
  ['animation', 'stack'],
  ['fantasy', 'sparkle']
]

function iconForGenre(label: string): string {
  const key = label.toLowerCase()
  return GENRE_ICON_KEYWORDS.find(([needle]) => key.includes(needle))?.[1] ?? 'sparkle'
}

export function GenreBlobRow({ genres, activeGenre, onSelect }: GenreBlobRowProps) {
  return (
    <section className={moodStyles.section} aria-label="Browse by genre">
      <h2 className={moodStyles.heading}>Browse By Genre</h2>
      <div className={`${moodStyles.cropX} thin-scroll`}>
        <div className={moodStyles.row}>
          {genres.map((genre) => {
            const isActive = activeGenre === genre.label
            return (
              <button
                key={genre.id}
                type="button"
                className={`${moodStyles.pill} animated-edge ${isActive ? `${moodStyles.pillActive} edge-active` : ''}`}
                style={{ ['--hue' as string]: genre.hue }}
                onClick={() => onSelect(isActive ? null : genre.label)}
                aria-pressed={isActive}
                aria-label={`Filter by ${genre.label}`}
              >
                <span className={`${moodStyles.pillHalo} breathing-glow`} aria-hidden="true" />
                <span className={moodStyles.pillIcon} aria-hidden="true">
                  <Icon name={iconForGenre(genre.label)} />
                </span>
                <span className={moodStyles.pillLabel}>{genre.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
