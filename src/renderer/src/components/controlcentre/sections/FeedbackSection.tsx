'use client'

// Feedback: somebody types what is wrong or what they would like, and
// chooses whether the app reports crashes and repeated actions on its own.
// Everything goes to the private feedback database, cleaned of account
// names, addresses and keys first (main/media-hub/feedback/), and the card
// shows exactly what will go before anything is sent.

import { useCallback, useEffect, useState } from 'react'
import type { FeedbackCategory, FeedbackPreview, FeedbackStatus } from '@shared/feedback/types'
import { usePanelVisible } from '../panelVisibility'
import { currentScreen } from '@renderer/lib/feedback/diagnostics'
import styles from './CachingSection.module.css'
import own from './FeedbackSection.module.css'

const CATEGORIES: Array<{ id: FeedbackCategory; label: string }> = [
  { id: 'bug', label: 'Something is wrong' },
  { id: 'idea', label: 'An idea' },
  { id: 'other', label: 'Something else' }
]

function when(iso: string | null): string {
  if (!iso) return 'not yet this session'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FeedbackSection() {
  const api = window.api?.mediaHub?.feedback
  const visible = usePanelVisible()
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [text, setText] = useState('')
  const [includeLog, setIncludeLog] = useState(true)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [status, setStatus] = useState<FeedbackStatus | null>(null)
  const [preview, setPreview] = useState<FeedbackPreview | null>(null)

  const refresh = useCallback(() => {
    void api
      ?.status?.()
      .then(setStatus)
      .catch(() => {})
  }, [api])

  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])

  const loadPreview = (): void => {
    void api
      ?.preview?.(includeLog)
      .then(setPreview)
      .catch(() => {})
  }

  if (!api) {
    return (
      <div className={styles.wrap}>
        <header className={styles.head}>
          <h2 className={styles.title}>Feedback</h2>
        </header>
        <section className={`${styles.card} glass-panel`}>
          <p className={styles.note}>Feedback is sent from the desktop app.</p>
        </section>
      </div>
    )
  }

  const send = async (): Promise<void> => {
    setSending(true)
    setResult(null)
    try {
      // The screen the control centre was opened over, not the
      // control centre itself.
      const { sent } = await api.send({ category, text, includeLog, page: currentScreen() })
      setResult(
        sent
          ? { ok: true, message: 'Sent. Thank you.' }
          : {
              ok: true,
              message: 'Saved. It will be sent as soon as the feedback server can be reached.'
            }
      )
      setText('')
      setPreview(null)
    } catch (error) {
      setResult({ ok: false, message: (error as Error)?.message || 'Could not send that.' })
    } finally {
      setSending(false)
      refresh()
    }
  }

  const setDiagnostics = (enabled: boolean): void => {
    void api
      .setDiagnostics(enabled)
      .then(setStatus)
      .catch(() => {})
  }

  const diagnosticsOn = status?.diagnosticsEnabled !== false

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h2 className={styles.title}>Feedback</h2>
        <p className={styles.blurb}>
          Tell us what went wrong or what you would like. It goes straight to the people building
          the app, without your name, your account names or your computer&apos;s name.
        </p>
      </header>

      <section className={`${styles.card} glass-panel`} aria-labelledby="feedback-send">
        <h3 id="feedback-send" className={styles.cardTitle}>
          Send feedback
        </h3>
        <div className={own.chips} role="radiogroup" aria-label="What kind of feedback">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={category === item.id}
              className={own.chip}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <textarea
          className={own.text}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            category === 'bug'
              ? 'What were you doing, what did you expect, and what happened instead?'
              : 'Tell us about it.'
          }
          aria-label="Your feedback"
          maxLength={8000}
        />
        <label className={own.check}>
          <input
            type="checkbox"
            checked={includeLog}
            onChange={(event) => {
              setIncludeLog(event.target.checked)
              setPreview(null)
            }}
          />
          Include the app&apos;s recent log (helps us find the cause)
        </label>
        <details
          className={own.disclosure}
          onToggle={(event) => {
            if ((event.target as HTMLDetailsElement).open) loadPreview()
          }}
        >
          <summary>See exactly what is sent</summary>
          {preview ? (
            <pre className={own.preview}>
              {`App version: ${preview.appVersion}\nSystem: ${preview.platform}\nScreen: ${currentScreen()}\n\nYour text, cleaned the same way as the log below.\n${
                includeLog
                  ? `\nLog (account names, addresses, links and keys already removed):\n${preview.log || '(empty)'}`
                  : '\nNo log.'
              }`}
            </pre>
          ) : (
            <p className={styles.note}>Loading…</p>
          )}
        </details>
        <div className={own.row}>
          {result ? (
            <p className={`${own.result} ${result.ok ? '' : own.resultError}`} role="status">
              {result.message}
            </p>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={sending || !text.trim()}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </section>

      <section className={`${styles.card} glass-panel`} aria-labelledby="feedback-auto">
        <div className={own.row}>
          <div>
            <h3 id="feedback-auto" className={styles.cardTitle}>
              Report problems automatically
            </h3>
            <p className={styles.note}>
              Sends a report when something goes wrong, so it can be fixed without you having to
              describe it.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={diagnosticsOn}
            className={diagnosticsOn ? styles.primaryButton : styles.ghostButton}
            onClick={() => setDiagnostics(!diagnosticsOn)}
          >
            {diagnosticsOn ? 'On' : 'Off'}
          </button>
        </div>
        <ul className={own.list}>
          <li>The app crashing, a window freezing, or the player stopping responding.</li>
          <li>Errors the app recovered from.</li>
          <li>
            The same button pressed again and again, or going back and forth between two screens.
            Only the button&apos;s name is sent, never anything you type.
          </li>
          <li>The app not closing properly last time.</li>
        </ul>
        <p className={styles.note}>
          Reports are cleaned before they leave this computer. A folder shows as{' '}
          <code>%USERPROFILE%\…</code> instead of your user name, and addresses, links to your own
          servers, emails and keys are removed. Reports carry a random id for this install so
          repeats can be counted, and nothing else that identifies you.
        </p>
        {status && (
          <p className={styles.note} role="status">
            {status.pending > 0
              ? `${status.pending} waiting to send. `
              : 'Nothing waiting to send. '}
            Last sent: {when(status.lastSentAt)}.{status.lastError ? ` ${status.lastError}` : ''}
          </p>
        )}
      </section>
    </div>
  )
}
