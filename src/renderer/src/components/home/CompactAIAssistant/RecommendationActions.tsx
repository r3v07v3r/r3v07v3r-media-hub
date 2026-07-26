'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { AI_PICKS } from '@renderer/data/mockData'
import { matchesCategoryKind, CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './CompactAIAssistant.module.css'

const ICON_BY_KIND: Record<CategoryKind, string> = {
  movie: 'play-outline',
  series: 'stack',
  anime: 'anime'
}
const LABEL_BY_KIND: Record<CategoryKind, string> = {
  movie: 'Recommend Next Movie',
  series: 'Recommend Next Series',
  anime: 'Recommend Next Anime'
}

export interface RecommendationActionsProps {
  /** Which quick-action buttons to show — Home shows both movie+series
   *  (unchanged default); a category page passes its own single kind so
   *  the panel is page-aware ("Recommend Next Anime" only appears on the
   *  Anime page, etc) rather than always offering all three. */
  kinds?: CategoryKind[]
}

export function RecommendationActions({ kinds = ['movie', 'series'] }: RecommendationActionsProps) {
  const { openDetail, pushNotification, catalog, recommendations, homeFeedLive } = useAppState()
  const [loading, setLoading] = useState<CategoryKind | null>(null)

  function recommend(kind: CategoryKind) {
    setLoading(kind)
    setTimeout(() => {
      setLoading(null)
      // Prefer the real recommendation backend (home:personalized's
      // genre-scored recommendations — see adapters.ts's
      // catalogItemToRecommendation) once it has actually loaded; only
      // fall back to a random pick from the browse catalog (still real
      // backend data when connected, see hooks.ts) or the mock AI_PICKS
      // pool when nothing live is available yet, rather than blocking the
      // button entirely.
      const liveMatches = homeFeedLive
        ? recommendations.map((r) => r.media).filter((m) => matchesCategoryKind(m, kind))
        : []
      const catalogMatches = catalog.filter((m) => matchesCategoryKind(m, kind))
      const pool = liveMatches.length
        ? liveMatches
        : catalogMatches.length
          ? catalogMatches
          : AI_PICKS.map((r) => r.media).filter((m) => matchesCategoryKind(m, kind))
      if (!pool.length) {
        pushNotification({
          tone: 'info',
          message: `No ${kind === 'anime' ? 'anime' : kind + 's'} available to recommend yet.`
        })
        return
      }
      const pick = pool[Math.floor(Math.random() * pool.length)]
      pushNotification({
        tone: 'success',
        message: `Recommendation ready: "${pick.title}"`
      })
      openDetail(pick)
    }, 1300)
  }

  return (
    <div className={styles.actions}>
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          className={styles.actionButton}
          onClick={() => recommend(kind)}
          disabled={loading !== null}
        >
          <Icon name={ICON_BY_KIND[kind]} />
          {LABEL_BY_KIND[kind]}
          {loading === kind && <span className={styles.actionSpinner} aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}
