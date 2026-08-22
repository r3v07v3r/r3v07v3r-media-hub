'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { AI_PICKS } from '@renderer/data/mockData'
import { matchesCategoryKind, CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { mediaItemToTitleRef } from '@renderer/lib/mediaHub/adapters'
import { MAX_PROMPT_TITLES } from '@shared/media-hub/ollama'
import type { MediaItem } from '@renderer/types'
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
const NOUN_BY_KIND: Record<CategoryKind, string> = {
  movie: 'movie',
  series: 'series',
  anime: 'anime'
}

/** Module scope, not a closure inside the component: react-hooks/purity
 *  reads a Math.random() call written inside a component body as a
 *  render-time impurity, even when the only path to it is an event
 *  handler. The pick is what it always was — uniform over the shortlist. */
function randomPick(pool: MediaItem[]): MediaItem {
  return pool[Math.floor(Math.random() * pool.length)]
}

export interface RecommendationActionsProps {
  /** Which quick-action buttons to show — Home shows both movie+series
   *  (unchanged default); a category page passes its own single kind so
   *  the panel is page-aware ("Recommend Next Anime" only appears on the
   *  Anime page, etc) rather than always offering all three. */
  kinds?: CategoryKind[]
}

export function RecommendationActions({ kinds = ['movie', 'series'] }: RecommendationActionsProps) {
  const { openDetail, pushNotification, catalog, recommendations, homeFeedLive, mediaHubSettings } =
    useAppState()
  const [loading, setLoading] = useState<CategoryKind | null>(null)
  const aiConnected = mediaHubSettings?.ollamaConnected ?? false

  // Prefer the real recommendation backend (home:personalized's
  // genre-scored recommendations — see adapters.ts's
  // catalogItemToRecommendation) once it has actually loaded; only fall
  // back to the browse catalog (still real backend data when connected,
  // see hooks.ts) or the mock AI_PICKS pool when nothing live is available
  // yet, rather than blocking the button entirely.
  function candidatePool(kind: CategoryKind): MediaItem[] {
    const liveMatches = homeFeedLive
      ? recommendations.map((r) => r.media).filter((m) => matchesCategoryKind(m, kind))
      : []
    if (liveMatches.length) return liveMatches
    const catalogMatches = catalog.filter((m) => matchesCategoryKind(m, kind))
    if (catalogMatches.length) return catalogMatches
    return AI_PICKS.map((r) => r.media).filter((m) => matchesCategoryKind(m, kind))
  }

  function announce(pick: MediaItem, reason: string) {
    pushNotification({
      tone: 'success',
      message: reason ? `${pick.title} — ${reason}` : `Recommendation ready: "${pick.title}"`
    })
    openDetail(pick)
  }

  async function recommend(kind: CategoryKind) {
    const pool = candidatePool(kind)
    if (!pool.length) {
      pushNotification({
        tone: 'info',
        message: `No ${kind === 'anime' ? 'anime' : kind + 's'} available to recommend yet.`
      })
      return
    }

    setLoading(kind)
    try {
      const api = window.api?.mediaHub?.ollama
      // With a model linked, the pick is genuinely the model's: it is shown
      // the same shortlist this button would otherwise choose from at
      // random, and its own one-line reason is what the toast says. Without
      // one, this stays exactly what it always was — a random pick from the
      // shortlist — including the short pause, so the button still feels
      // like it did something rather than firing instantly.
      if (api && aiConnected) {
        const shortlist = pool.slice(0, MAX_PROMPT_TITLES)
        const result = await api.recommend(NOUN_BY_KIND[kind], shortlist.map(mediaItemToTitleRef))
        const picked = shortlist.find((item) => item.id === result.id)
        // An id the shortlist doesn't contain means the model answered with
        // something that wasn't on offer — fall through to the random pick
        // rather than showing nothing.
        if (picked) {
          announce(picked, result.reason)
          return
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1300))
      }
      announce(randomPick(pool), '')
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'The model could not be reached.'
      })
    } finally {
      setLoading(null)
    }
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
