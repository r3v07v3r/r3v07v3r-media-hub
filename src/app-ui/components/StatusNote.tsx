import type { ReactNode } from 'react'

/** The one loading/empty/error line every screen needs somewhere. `tone`
 *  controls both the colour and whether it's announced as an alert. */
export default function StatusNote({ tone, children }: { tone?: 'error'; children: ReactNode }) {
  return (
    <p
      className={tone === 'error' ? 'status-note status-note--error' : 'status-note'}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  )
}
