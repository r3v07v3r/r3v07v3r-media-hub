import type { ReactNode } from 'react'

/** A button on the line itself: the one thing to do about what it says. */
export interface StatusNoteAction {
  label: string
  onClick: () => void
}

/** The one loading/empty/error line every screen needs somewhere. `tone`
 *  controls both the colour and whether it's announced as an alert. A line
 *  with an `action` carries that one button, and one that is not an error is
 *  announced as a status, so the button is found along with the words. */
export default function StatusNote({
  tone,
  action,
  secondaryAction,
  children
}: {
  tone?: 'error'
  action?: StatusNoteAction
  /** A second way out, after `action` (only drawn alongside one). */
  secondaryAction?: StatusNoteAction
  children: ReactNode
}) {
  const className = [
    'status-note',
    tone === 'error' ? 'status-note--error' : '',
    action ? 'status-note--action' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <p className={className} role={tone === 'error' ? 'alert' : action ? 'status' : undefined}>
      {action ? <span>{children}</span> : children}
      {action && (
        <button type="button" className="status-note__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {action && secondaryAction && (
        <button type="button" className="status-note__action" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
    </p>
  )
}
