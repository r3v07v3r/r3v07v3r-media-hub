'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './FeaturedHero.module.css'

export function HeroActions({ item }: { item: MediaItem }) {
  const { startPartyPlayback, myList, toggleMyList } = useAppState()
  const saved = myList.has(item.id)

  return (
    <div className={styles.actions}>
      <button type="button" className={styles.watchNow} onClick={() => startPartyPlayback(item)}>
        <Icon name="play" />
        Watch Now
      </button>
      <button
        type="button"
        className={styles.myList}
        onClick={() => toggleMyList(item)}
        aria-pressed={saved}
      >
        <Icon name={saved ? 'check' : 'plus'} />
        {saved ? 'Planned' : 'Plan to Watch'}
      </button>
    </div>
  )
}
