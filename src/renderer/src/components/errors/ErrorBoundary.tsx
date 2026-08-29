// The last thing standing between a render-time throw and a black window.
//
// React unmounts the entire tree when a render, lifecycle or constructor
// throws and nothing catches it — and with no boundary anywhere in this app,
// that is exactly what happened: a single bad field on one IPC payload
// (collection.ts's partial CatalogItem, which made adapters.ts iterate an
// undefined `genres`) took the whole window to an empty black rectangle, with
// no message, no way back, and nothing written down about why.
//
// The fix for that specific throw is in the two files named above. This is
// the general answer: whatever the next one turns out to be, it should cost
// the user the panel it happened in, not the application.

import { Component, type ErrorInfo, type ReactNode } from 'react'

import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
  /** What broke, in the user's terms — "this page", "the episode list". Used
   *  in the fallback's own copy, so it should read as a noun phrase. */
  label?: string
  /** Changing this remounts the boundary, clearing a caught error. The route
   *  key is passed here so navigating away from a page that threw actually
   *  recovers instead of leaving the fallback pinned in place forever. */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  // Kept as a console report rather than a toast: the notification system
  // lives inside the tree this boundary is catching for, so reaching into it
  // from here risks a second throw while handling the first. The devtools
  // console (and the packaged build's log) is where the stack is useful
  // anyway.
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const what = this.props.label ?? 'this part of the app'
    return (
      <div className={styles.fallback} role="alert">
        <h1 className={styles.heading}>Something went wrong showing {what}</h1>
        {/* The message, not the stack. It is the one line that occasionally
            tells someone what to do (a missing API key, an offline backend),
            and a stack trace in the UI helps nobody who is not already
            reading the console. */}
        <p className={styles.detail}>{error.message || 'An unexpected error occurred.'}</p>
        <p className={styles.hint}>
          The rest of the app is still running — you can go back, or try again.
        </p>
        <button type="button" className={styles.retry} onClick={this.handleRetry}>
          Try again
        </button>
      </div>
    )
  }
}
