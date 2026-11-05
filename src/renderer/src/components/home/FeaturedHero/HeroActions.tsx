'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { TitleStatusButton } from '@renderer/components/media/TitleStatusButton'
import { titleUnreleased } from '@renderer/lib/mediaHub/releaseDate'
import styles from './FeaturedHero.module.css'

export function HeroActions({ item }: { item: MediaItem }) {
  const { startPartyPlayback } = useAppState()
  // The hero puts a title in front of somebody unasked, and that title can
  // be one that is not out yet. Watch Now then says when instead — the
  // same gate the detail page's Play applies (DetailHero), from what the
  // card-level record knows (titleUnreleased).
  const unreleased = titleUnreleased(item)

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={`${styles.watchNow} ${unreleased ? styles.watchNowUnreleased : ''}`}
        onClick={() => {
          if (!unreleased) startPartyPlayback(item)
        }}
        disabled={!!unreleased}
        aria-disabled={!!unreleased}
      >
        <Icon name={unreleased ? 'clock' : 'play'} />
        {unreleased ?? 'Watch Now'}
      </button>
      {/* The status pill rather than a plan-only toggle: the hero is the
          one place a title is put in front of somebody unasked, and
          "seen it" is as common an answer as "later". */}
      <TitleStatusButton media={item} variant="hero" />
    </div>
  )
}
