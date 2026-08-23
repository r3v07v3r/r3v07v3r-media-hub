'use client'

import { useEffect, useRef, useState } from 'react'
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

/** Never reused within a session, so a cancel can never land on a later
 *  request that happens to have been numbered the same. Module scope rather
 *  than a ref because this panel is mounted by Home AND by each category
 *  page, and a per-instance counter would restart at 1 on every navigation.
 *  See ollamaService.ts's inFlight map. */
let requestSequence = 0

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

  // A recommendation ends by NAVIGATING (openDetail), which makes a stale
  // one actively hostile rather than merely wasted: leave Home while a model
  // is still thinking and, up to two minutes later, the app would yank the
  // person off whatever page they had since opened and onto a title they
  // asked about on a page they have left. So this panel tracks whether it is
  // still mounted, and tells main to stop generating when it isn't.
  const mountedRef = useRef(true)
  const pendingRequestId = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const pending = pendingRequestId.current
      pendingRequestId.current = null
      if (pending) window.api?.mediaHub?.ollama?.cancel(pending).catch(() => {})
    }
  }, [])

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

  /** A model chose this one, and said why. */
  function announceModelPick(pick: MediaItem, reason: string) {
    pushNotification({
      tone: 'success',
      message: reason ? `${pick.title} — ${reason}` : `Recommendation ready: "${pick.title}"`
    })
    openDetail(pick)
  }

  /**
   * Nothing chose this one — it came off a coin flip, and the toast says so.
   *
   * The button still works without a model, because it always did and taking
   * that away would be a regression for anyone who never sets Ollama up. But
   * a random pick presented as "Recommendation ready" is the app claiming
   * something it didn't do, which is the exact habit the rest of this work
   * removed.
   *
   * `modelDeclined` distinguishes the two ways of getting here, and comes
   * from what main actually reported rather than from a settings snapshot
   * that may not have loaded yet — telling someone to connect a model they
   * already have is its own small lie.
   */
  function announceRandomPick(pick: MediaItem, modelDeclined: boolean) {
    pushNotification({
      tone: 'info',
      message: modelDeclined
        ? `Picked "${pick.title}" at random — the model didn't choose from the list.`
        : `Picked "${pick.title}" at random. Connect a local model in Settings → AI for a real recommendation.`
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

    const requestId = `recommend-${++requestSequence}`
    pendingRequestId.current = requestId
    setLoading(kind)
    try {
      const api = window.api?.mediaHub?.ollama
      // With a model linked, the pick is genuinely the model's: it is shown
      // the same shortlist this button would otherwise choose from at
      // random, and its own one-line reason is what the toast says. Without
      // one, this stays what it always was — a random pick — but announced
      // as one.
      //
      // The 1.3s pause that used to sit on this path is gone. It existed to
      // make the button feel like it was thinking; nothing was, and a fake
      // deliberation in front of a coin flip is the same theatre as the
      // hardcoded assistant answer and the mute microphone this work
      // removed. An instant answer is the honest one.
      // Main is asked whenever the bridge exists — the settings snapshot is
      // deliberately not consulted. It was, and it defaulted to "no model"
      // in two situations where that was wrong: before the first settings
      // fetch landed, and after main had recorded `false` for an Ollama
      // that has since been started. Main looks again on this very call
      // (ollamaService's resolveConfig) and answers `unavailable` when
      // there genuinely is nothing, so the round trip is what turns a
      // guess into an answer.
      let modelDeclined = false
      if (api) {
        const shortlist = pool.slice(0, MAX_PROMPT_TITLES)
        const result = await api.recommend(
          NOUN_BY_KIND[kind],
          shortlist.map(mediaItemToTitleRef),
          requestId
        )
        // Cancelled, or this panel is gone — either way nobody is waiting on
        // this any more, and announcing it would navigate them somewhere
        // they never asked to go.
        if (!mountedRef.current || result.cancelled) return
        const picked = shortlist.find((item) => item.id === result.id)
        // An id the shortlist doesn't contain means the model answered with
        // something that wasn't on offer — fall through to the random pick
        // rather than showing nothing.
        if (picked) {
          announceModelPick(picked, result.reason)
          return
        }
        // `unavailable` is main saying there was no model to ask, which is
        // the one case that should still point at Settings.
        modelDeclined = !result.unavailable
      }
      announceRandomPick(randomPick(pool), modelDeclined)
    } catch (error) {
      // Same reasoning as above: an error toast for a page the person has
      // already left is noise about something they stopped caring about.
      if (!mountedRef.current) return
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'The model could not be reached.'
      })
    } finally {
      if (pendingRequestId.current === requestId) pendingRequestId.current = null
      if (mountedRef.current) setLoading(null)
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
