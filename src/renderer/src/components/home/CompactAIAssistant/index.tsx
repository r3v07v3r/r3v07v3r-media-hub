'use client'

import { useEffect, useState } from 'react'
import { AIOrb } from './AIOrb'
import { AssistantStatus } from './AssistantStatus'
import { RecommendationActions } from './RecommendationActions'
import { CompactStatusBar } from './CompactStatusBar'
import styles from './CompactAIAssistant.module.css'

export function CompactAIAssistant() {
  const [isCompact, setIsCompact] = useState(false)

  // Mobile gets a single-line "compact assistant status" (spec section 8,
  // item 3) instead of the full orb + recommendation-buttons panel — at
  // phone width the full panel would eat most of the fold before the
  // hero even appears. Tablet needs the same treatment: the tablet layout
  // (spec section 7) puts hero first in visual priority ("hero → picks →
  // continue-watching-carousel → mood"), and the full 300px-tall orb
  // panel pushed the hero below the fold when it led the single-column
  // stack — so anything under the 1100px "desktop" threshold collapses
  // the assistant to the same slim status bar mobile uses.
  useEffect(() => {
    function apply() {
      setIsCompact(window.innerWidth < 1100)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  if (isCompact) {
    return <CompactStatusBar />
  }

  return (
    <section className={styles.panel} aria-label="AI assistant">
      <AIOrb />
      <AssistantStatus />
      <RecommendationActions />
    </section>
  )
}
