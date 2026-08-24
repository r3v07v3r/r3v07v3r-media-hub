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
  const { catalog, catalogLoading, recommendations, mediaHubSettings } = useAppState()
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
        <MediaGrid
          items={results}
          loading={catalogLoading}
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
