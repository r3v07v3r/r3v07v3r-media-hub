'use client'

import { useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { useOverlayActions, useOverlayState } from '@renderer/context/OverlayContext'
import { Icon } from '@renderer/components/icons/Icon'
import { positionFloatingPanel } from '@renderer/lib/floatingPanel'
import styles from './Overlays.module.css'

export function ContextMenu() {
  // The open menu itself comes from the overlay context — see
  // OverlayContext.tsx for why it no longer lives in the app-wide one.
  const { contextMenu } = useOverlayState()
  const { closeContextMenu } = useOverlayActions()
  const {
    startPartyPlayback,
    toggleMyList,
    myList,
    toggleDisliked,
    dislikedIds,
    markContinueWatching,
    pushNotification,
    openDetail
  } = useAppState()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeContextMenu()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu, closeContextMenu])

  if (!contextMenu) return null
  const { media, x, y } = contextMenu
  const saved = myList.has(media.id)
  const disliked = dislikedIds.has(media.id)

  const { left, top } = positionFloatingPanel(x, y, 224, 320, window.innerWidth, window.innerHeight)

  const items: { icon: string; label: string; onSelect: () => void }[] = [
    { icon: 'play', label: 'Play', onSelect: () => startPartyPlayback(media) },
    {
      icon: saved ? 'check' : 'plus',
      label: saved ? 'Remove from My List' : 'Add to My List',
      onSelect: () => toggleMyList(media)
    },
    {
      icon: 'check',
      label: media.watched ? 'Mark unwatched' : 'Mark watched',
      onSelect: () => markContinueWatching(media.id, !media.watched, media)
    },
    {
      icon: 'thumbs-down',
      label: disliked ? 'Remove dislike' : 'Not interested',
      onSelect: () => {
        toggleDisliked(media)
        pushNotification({
          tone: 'info',
          message: disliked
            ? `You'll see "${media.title}" again.`
            : `Got it — "${media.title}" won't show up in recommendations, and you can hide it from browsing with the Hide Disliked filter.`
        })
      }
    },
    {
      icon: 'grid',
      label: 'More like this',
      onSelect: () => openDetail(media)
    },
    {
      icon: 'info',
      label: 'Why recommended?',
      onSelect: () =>
        pushNotification({
          tone: 'info',
          message: `Recommended because it matches your recent ${media.genres[0] ?? 'viewing'} activity.`
        })
    }
  ]

  return (
    <div
      ref={menuRef}
      className={`${styles.contextMenu} glass-panel`}
      style={{ left, top }}
      role="menu"
      aria-label={`Actions for ${media.title}`}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={styles.contextMenuItem}
          onClick={() => {
            item.onSelect()
            closeContextMenu()
          }}
        >
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
    </div>
  )
}
