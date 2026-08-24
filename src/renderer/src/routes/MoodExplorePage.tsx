'use client'

import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { MoodCategory } from '@renderer/types'
import { MOOD_CATEGORIES } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaGrid } from '@renderer/components/category/MediaGrid'
import { rankMoodSpotlight } from '@renderer/lib/mediaHub/moodSpotlight'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import styles from './MoodExplorePage.module.css'

function selectedMoodIds(value: string | null, moods: MoodCategory[]): string[] {
  const validIds = new Set(moods.map((mood) => mood.id))
  return Array.from(
    new Set(
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => validIds.has(id))
    )
  )
}

/** The explicit full-catalog destination behind Mood Spotlight's compact tray. */
export default function MoodExplorePage() {
  const { catalog, catalogKindStates, refreshCatalog, recommendations, mediaHubSettings } =
    useAppState()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const moodParam = searchParams.get('mood')
  const moods = useMemo(() => selectedMoodIds(moodParam, MOOD_CATEGORIES), [moodParam])
  const moodLabels = moods
    .map((id) => MOOD_CATEGORIES.find((mood) => mood.id === id)?.label)
    .filter((label): label is string => Boolean(label))
  const leadMood = MOOD_CATEGORIES.find((mood) => mood.id === moods[0])
  const results = useMemo(
    () =>
      rankMoodSpotlight(catalog, recommendations, moods, {
        hideWatched: mediaHubSettings?.hideWatchedDefault ?? false,
        hideCompleted: mediaHubSettings?.hideCompletedDefault ?? false,
        hideDisliked: mediaHubSettings?.hideDislikedDefault ?? false
      }),
    [catalog, recommendations, moods, mediaHubSettings]
  )

  // Same three-way distinction the Mood Spotlight tray makes (see
  // MoodBrowser): an empty grid because nothing matched is the person's
  // filters, an empty grid because nothing could be fetched is not, and
  // only the latter deserves a Retry rather than a nudge toward Settings.
  const kindStates = Object.values(catalogKindStates)
  const catalogEmpty = catalog.length === 0
  const stillArriving = catalogEmpty && kindStates.some((state) => state === 'loading')
  // Nothing at all could be loaded — the grid's own error state.
  const unavailable = !stillArriving && kindStates.every((state) => state === 'failed')
  // A source behind the results actually shown failed. Asked of the
  // results rather than of the catalog, and not requiring every source to
  // fail — see MoodBrowser, which makes the same distinction.
  const resultsMayBeStale = useMemo(
    () =>
      !stillArriving &&
      results.some((item) => item.mediaKind && catalogKindStates[item.mediaKind] === 'failed'),
    [stillArriving, results, catalogKindStates]
  )

  useRestoreBrowsingOrigin(true)

  return (
    <div
      className={styles.page}
      style={{ ['--mood-accent' as string]: leadMood?.accent ?? 'var(--accent-cyan)' }}
    >
      <header className={styles.header}>
        <button type="button" className={styles.backButton} onClick={() => navigate('/')}>
          <Icon name="chevron-left" size={15} />
          Home
        </button>
        <div className={styles.signal} aria-hidden="true">
          <Icon name={leadMood?.icon ?? 'sparkle'} size={18} />
        </div>
        <div className={styles.titleGroup}>
          <span className={styles.kicker}>Mood collection</span>
          <h1>{moodLabels.length > 0 ? moodLabels.join(' + ') : 'Choose a mood'}</h1>
          <p>
            {moodLabels.length > 0
              ? `${results.length} titles selected from your library.`
              : 'Return home and choose a mood to explore its full collection.'}
          </p>
        </div>
      </header>

      <section className={styles.results} aria-label={moodLabels.join(' + ') || 'Mood results'}>
        {/* Results are showing but nothing could refresh them — qualify
            them rather than replace them. With none showing, the grid's
            own error state below carries the failure and the Retry. */}
        {resultsMayBeStale && (
          <p className={styles.staleNotice} role="status">
            <Icon name="wifi-off" size={13} />
            Couldn&apos;t reach the media hub backend — these may be out of date.
            <button type="button" onClick={refreshCatalog} className={styles.staleRetry}>
              <Icon name="refresh" size={13} />
              Retry
            </button>
          </p>
        )}
        <MediaGrid
          items={results}
          loading={stillArriving}
          error={unavailable && catalogEmpty}
          errorTitle="Couldn't reach the media hub backend"
          onRetry={refreshCatalog}
          emptyTitle={
            moodLabels.length > 0
              ? `No ${moodLabels.join(' + ')} titles to show`
              : 'No mood selected'
          }
          emptyMessage={
            moodLabels.length > 0
              ? 'Try showing watched or completed titles in Settings, then return to this mood.'
              : 'Your next watch is waiting on the Home screen.'
          }
        />
      </section>
    </div>
  )
}
