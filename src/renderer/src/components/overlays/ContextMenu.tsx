'use client'

import { useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

export function ContextMenu() {
  const {
    contextMenu,
    closeContextMenu,
    startPartyPlayback,
    toggleMyList,
    myList,
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

  const left = Math.min(x, window.innerWidth - 224)
  const top = Math.min(y, window.innerHeight - 320)

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
      onSelect: () => markContinueWatching(media.id, !media.watched)
    },
    {
      icon: 'thumbs-down',
      label: 'Not interested',
      onSelect: () =>
        pushNotification({
          tone: 'info',
          message: `Got it — you'll see less like "${media.title}".`
        })
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
