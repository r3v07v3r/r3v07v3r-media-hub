'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { TitleStatusButton } from '@renderer/components/media/TitleStatusButton'
import styles from './FeaturedHero.module.css'

export function HeroActions({ item }: { item: MediaItem }) {
  const { startPartyPlayback } = useAppState()

  return (
    <div className={styles.actions}>
      <button type="button" className={styles.watchNow} onClick={() => startPartyPlayback(item)}>
        <Icon name="play" />
        Watch Now
      </button>
      {/* The status pill rather than a plan-only toggle: the hero is the
          one place a title is put in front of somebody unasked, and
          "seen it" is as common an answer as "later". */}
      <TitleStatusButton media={item} variant="hero" />
    </div>
  )
}
