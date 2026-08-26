// Where else this can be watched.
//
// The one gap in the competitive analysis that nobody expects a media app to
// have: Stremio, Simkl, Trakt, JustWatch and Reelgood all answer it. Somebody
// looking at a title they cannot get any other way is asking exactly this.
//
// Renders nothing at all when there is nothing to say — no TMDB key, no entry,
// or nothing available in this region. A panel headed "Where to watch" over an
// empty box is worse than no panel, and "not available where you are" is a
// real answer that the region line below already carries when there IS
// something to show.

import { useEffect, useState } from 'react'

import type { MediaItem } from '@renderer/types'
import type { WatchProvidersResult } from '@shared/media-hub/types'
import styles from './WhereToWatchPanel.module.css'

function Row({ label, providers }: { label: string; providers: WatchProvidersResult['stream'] }) {
  if (providers.length === 0) return null
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <ul className={styles.services}>
        {providers.map((provider) => (
          <li key={provider.id} className={styles.service} title={provider.name}>
            {provider.logo ? (
              <img src={provider.logo} alt={provider.name} className={styles.logo} />
            ) : (
              <span className={styles.logoFallback}>{provider.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function WhereToWatchPanel({ media }: { media: MediaItem }) {
  // The answer carries the title it is about.
  //
  // Navigating from one movie to another reuses this component, so a bare
  // result stayed on screen under the new title while its lookup ran — and if
  // that lookup failed, or the new title had no supported id at all, it stayed
  // there indefinitely, confidently listing the first film's services on the
  // second film's page. Keying it means a mismatched answer is simply not
  // rendered, with no ordering in which it can be.
  const [result, setResult] = useState<{ key: string; value: WatchProvidersResult } | null>(null)
  const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
  const lookupKey = `${kind}:${media.id}`

  useEffect(() => {
    const api = window.api?.mediaHub
    // Anime is skipped in main too, for the same reason the request panel
    // skips it: a Kitsu id cannot be looked up on TMDB, and matching by title
    // is how a page confidently lists the services for a different show.
    if (!api || kind === 'anime' || !/^tt\d+$/.test(media.id)) return
    let cancelled = false
    api.catalog
      .providers(kind, media.id)
      .then((found) => {
        if (!cancelled) setResult({ key: lookupKey, value: found })
      })
      .catch(() => {
        // Nothing to show and nothing to keep: the panel disappears rather
        // than leaving the previous title's services standing.
        if (!cancelled) setResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [kind, media.id, lookupKey])

  // A result for a different title is no result at all — which also covers
  // the early return above, where an unsupported id leaves the last answer
  // untouched rather than replacing it.
  if (result?.key !== lookupKey) return null
  const providers = result.value
  const anything = providers.stream.length || providers.rent.length || providers.buy.length
  if (!anything) return null

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Where to watch">
      <div className={styles.head}>
        <h2 className={styles.heading}>Where to watch</h2>
        <span className={styles.region}>{providers.region}</span>
      </div>
      <Row label="Streaming" providers={providers.stream} />
      <Row label="Rent" providers={providers.rent} />
      <Row label="Buy" providers={providers.buy} />
      {/* TMDB carries JustWatch's data and asks that it be credited. Saying so
          is also the honest thing: this is not the app's own answer. */}
      <p className={styles.credit}>
        Availability from JustWatch via TMDB. Change your region in Settings.
      </p>
    </section>
  )
}
