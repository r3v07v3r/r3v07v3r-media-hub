// Everything this catalog has of one person's, reached by clicking their name.
//
// A route rather than an overlay, because it genuinely is one: it reloads into
// something meaningful, the back button does the obvious thing, and the name
// is the only state it needs. Not a nav destination — the roadmap's first
// ground rule keeps that at seven — but a drill-down from a title page, the
// same way a title itself is.
//
// The answer is LOCAL. TMDB would give a complete filmography including
// everything this app cannot play, which is the wrong answer to the question
// somebody is actually asking by clicking a name on a title page: what else of
// theirs can I watch now. See main/media-hub/credits.ts's titlesFeaturing.

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { MediaGrid } from '@renderer/components/category/MediaGrid'
import { useAppState } from '@renderer/context/AppStateContext'
import { catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import type { MediaItem } from '@renderer/types'
import type { PersonCreditsResult } from '@shared/media-hub/types'
import styles from './MyStuff.module.css'

export default function PersonPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const { myList, dislikedIds } = useAppState()
  const person = decodeURIComponent(name ?? '')
  const [result, setResult] = useState<PersonCreditsResult | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(
    // Outside the desktop app there is no bridge and nothing to wait for, so
    // this starts "already answered" rather than spinning forever.
    window.api?.mediaHub ? null : person
  )
  // Reset during render rather than from the effect: clicking a second name
  // without leaving the page changes `person`, and setting the loading state
  // inside the effect both cascades a render and leaves one frame showing the
  // PREVIOUS person's filmography under the new person's name.
  const [personShown, setPersonShown] = useState(person)
  if (personShown !== person) {
    setPersonShown(person)
    setResult(null)
    setLoadedFor(window.api?.mediaHub ? null : person)
  }
  const loaded = loadedFor === person

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api || !person) return
    let cancelled = false
    api.catalog
      .person(person)
      .then((found) => {
        if (cancelled) return
        setResult(found)
        setLoadedFor(person)
      })
      .catch(() => {
        if (!cancelled) setLoadedFor(person)
      })
    return () => {
      cancelled = true
    }
  }, [person])

  // The grids want MediaItems, and the tracking flags are what make a card
  // show its My List and Not-interested state. Watched state is deliberately
  // left off: it would mean a second history read for a page that is a
  // side-trip, and the card falls back to showing none rather than the wrong
  // one.
  const toItems = (items: PersonCreditsResult['cast']): MediaItem[] =>
    items.map((item) => catalogItemToMediaItem(item, { trackedIds: myList, dislikedIds }))

  const cast = result ? toItems(result.cast) : []
  const creators = result ? toItems(result.creators) : []
  const nothing = loaded && cast.length === 0 && creators.length === 0

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>{person}</h1>

      {!loaded && <p className={styles.empty}>Looking through your catalog…</p>}

      {nothing && (
        <p className={styles.empty}>
          Nothing else of theirs here yet. Cast and crew are filled in over several sessions in the
          background, so a title you opened recently may not have been covered.
        </p>
      )}

      {creators.length > 0 && (
        <section className={styles.statSection}>
          <h2 className={styles.statHeading}>Directed or created</h2>
          <MediaGrid items={creators} />
        </section>
      )}

      {cast.length > 0 && (
        <section className={styles.statSection}>
          <h2 className={styles.statHeading}>Appears in</h2>
          <MediaGrid items={cast} />
        </section>
      )}

      <button type="button" className={styles.backLink} onClick={() => navigate(-1)}>
        ← Back
      </button>
    </div>
  )
}
