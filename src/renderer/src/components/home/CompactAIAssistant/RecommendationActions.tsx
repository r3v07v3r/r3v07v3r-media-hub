'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { AI_PICKS } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './CompactAIAssistant.module.css'

export function RecommendationActions() {
  const { openDetail, pushNotification, catalog } = useAppState()
  const [loading, setLoading] = useState<'movie' | 'series' | null>(null)

  function recommend(kind: 'movie' | 'series') {
    setLoading(kind)
    setTimeout(() => {
      setLoading(null)
      const pool = catalog.filter((m) => m.mediaType === kind)
      const pick = (pool.length ? pool : AI_PICKS.map((r) => r.media))[
        Math.floor(Math.random() * (pool.length || AI_PICKS.length))
      ]
      pushNotification({
        tone: 'success',
        message: `Recommendation ready: "${pick.title}"`
      })
      openDetail(pick)
    }, 1300)
  }

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => recommend('movie')}
        disabled={loading !== null}
      >
        <Icon name="play-outline" />
        Recommend Next Movie
        {loading === 'movie' && <span className={styles.actionSpinner} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => recommend('series')}
        disabled={loading !== null}
      >
        <Icon name="stack" />
        Recommend Next Series
        {loading === 'series' && <span className={styles.actionSpinner} aria-hidden="true" />}
      </button>
    </div>
  )
}
