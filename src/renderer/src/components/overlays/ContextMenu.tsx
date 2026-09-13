'use client'

import { useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { useOverlayActions, useOverlayState } from '@renderer/context/OverlayContext'
import { Icon } from '@renderer/components/icons/Icon'
import { positionFloatingPanel } from '@renderer/lib/floatingPanel'
import { titleStatusOf, TITLE_STATUS_ACTION } from '@renderer/lib/mediaHub/titleStatus'
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
    setTitleStatus,
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

  // A movie's watched state is a single toggle with no season/episode
  // needed. A series/anime card only carries real season/episode numbers
  // when it came from Continue Watching (see continueWatchingEntryToItem in
  // lib/mediaHub/adapters.ts) — a plain browse-grid card never has them.
  // Marking watched/unwatched without them used to write a bogus
  // `id:movie:movie` history row (and push an equally bogus "season 1,
  // episode undefined" entry to Simkl) instead of tracking anything real —
  // found live. Per-episode marking already exists and works correctly on
  // the title's own detail page (EpisodesSection); this menu item is
  // limited to the cases it can actually represent correctly rather than
  // silently corrupting the rest.
  // Whole-title, whatever the card knows: main resolves a show's own
  // episode list, so "Mark watched" on a series card marks every aired
  // episode rather than being missing (it used to be offered only when
  // the card happened to carry an episode number).
  const status = titleStatusOf(media, { planned: saved })
  const watched = status === 'watched'

  const items: { icon: string; label: string; onSelect: () => void }[] = [
    { icon: 'play', label: 'Play', onSelect: () => startPartyPlayback(media) },
    {
      icon: saved ? 'x' : 'clock',
      label: saved ? 'Remove from plan' : TITLE_STATUS_ACTION.planned,
      onSelect: () => toggleMyList(media)
    },
    {
      icon: watched ? 'eye-off' : 'check',
      label: watched ? TITLE_STATUS_ACTION.unwatched : TITLE_STATUS_ACTION.watched,
      onSelect: () => setTitleStatus(media, watched ? 'unwatched' : 'watched')
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
    }
    // "Why recommended?" is gone. It invented a genre-shaped reason on the
    // spot; the real one is the chip on the card (see MediaCard).
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
