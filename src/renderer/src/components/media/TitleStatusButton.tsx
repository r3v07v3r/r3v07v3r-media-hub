'use client'

// The one control for a title's status: not watched -> plan to watch ->
// watched -> not watched, one click each. It replaces the pair of toggles
// every surface used to carry — a "My List"/"Follow"/"Plan to Watch"
// button beside a separate "Mark watched" one, each worded differently —
// with one pill that says where the title stands and moves it on.
//
// Three shapes, one behaviour: `chip` for the detail page's panel header,
// `action` for the library's side panel, `hero` beside Watch Now on Home.

import type { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  nextTitleStatus,
  titleStatusOf,
  TITLE_STATUS_ACTION,
  TITLE_STATUS_ICON,
  TITLE_STATUS_LABEL,
  type TitleStatusOverrides
} from '@renderer/lib/mediaHub/titleStatus'
import styles from './TitleStatusButton.module.css'

export interface TitleStatusButtonProps extends TitleStatusOverrides {
  media: MediaItem
  variant?: 'chip' | 'action' | 'hero'
  className?: string
}

export function TitleStatusButton({
  media,
  variant = 'chip',
  className,
  watched,
  planned,
  progress
}: TitleStatusButtonProps) {
  const { myList, watchedIds, setTitleStatus } = useAppState()
  // The plan and watched sets are live app state; a MediaItem's own flags
  // can be a render behind after a click elsewhere on the page, and some
  // items never carried them at all — the Home hero's come from the
  // recommendation list, which is built without the watch history, so a
  // film seen last month read "Not watched" up there. For a show the set
  // only says "started", which is exactly what "watching" means.
  const seen = watchedIds.has(media.id)
  const status = titleStatusOf(seen ? { ...media, watched: true } : media, {
    watched,
    planned: planned ?? myList.has(media.id),
    progress
  })
  const next = nextTitleStatus(status)
  const label = TITLE_STATUS_LABEL[status]
  const count = status === 'watching' && progress ? ` · ${progress.watched}/${progress.total}` : ''

  return (
    <button
      type="button"
      className={`${styles.button} ${styles[variant]} ${styles[status]} ${className ?? ''}`}
      data-status={status}
      onClick={() => setTitleStatus(media, next)}
      title={TITLE_STATUS_ACTION[next]}
      aria-label={`${label}${count}. ${TITLE_STATUS_ACTION[next]}`}
    >
      <Icon name={TITLE_STATUS_ICON[status]} size={variant === 'hero' ? 16 : 13} />
      <span className={styles.label}>
        {label}
        {count && <span className={styles.count}>{count}</span>}
      </span>
    </button>
  )
}
