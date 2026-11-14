// The Feedback section's channels, and the renderer's own problem reports
// (render errors, rejected promises, repeated clicks).

import { MEDIA_HUB_CHANNELS } from '../../../shared/media-hub/ipc-channels'
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  type FeedbackCategory,
  type FeedbackPreview,
  type FeedbackStatus,
  type RendererProblem
} from '../../../shared/feedback/types'
import { handle } from '../ipcGuard'
import {
  feedbackPreview,
  feedbackStatus,
  reportProblem,
  sendFeedback,
  setDiagnosticsEnabled
} from './reporter'

/** Keeps only small flat values from whatever the renderer sent. */
function flatContext(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(
    0,
    FEEDBACK_LIMITS.contextKeys
  )) {
    if (typeof item === 'number' || typeof item === 'boolean') out[key.slice(0, 40)] = item
    else if (typeof item === 'string')
      out[key.slice(0, 40)] = item.slice(0, FEEDBACK_LIMITS.contextValue)
  }
  return out
}

export function registerFeedbackIpc(): void {
  handle<
    { category?: string; text?: string; includeLog?: boolean; page?: string },
    { sent: boolean }
  >(MEDIA_HUB_CHANNELS.feedbackSend, (_e, payload) =>
    sendFeedback({
      category: FEEDBACK_CATEGORIES.includes(payload?.category as FeedbackCategory)
        ? (payload!.category as FeedbackCategory)
        : 'other',
      text: String(payload?.text ?? '').slice(0, FEEDBACK_LIMITS.body),
      includeLog: payload?.includeLog === true,
      context: payload?.page ? { page: String(payload.page).slice(0, 120) } : undefined
    })
  )

  handle<RendererProblem, void>(MEDIA_HUB_CHANNELS.feedbackReportProblem, (_e, payload) => {
    if (!payload || (payload.kind !== 'error' && payload.kind !== 'friction')) return
    const fingerprint =
      typeof payload.fingerprint === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(payload.fingerprint)
        ? payload.fingerprint
        : undefined
    reportProblem({
      kind: payload.kind,
      title: String(payload.title ?? '').slice(0, 500),
      stack: typeof payload.stack === 'string' ? payload.stack.slice(0, 4000) : undefined,
      fingerprint,
      context: { process: 'renderer', ...flatContext(payload.context) },
      // A render error's own stack is usually enough; the log helps with
      // what the main process was doing at the time of a repeated click.
      withLog: payload.kind === 'friction'
    })
  })

  handle<undefined, FeedbackStatus>(MEDIA_HUB_CHANNELS.feedbackStatus, () => feedbackStatus())

  handle<{ enabled?: boolean }, FeedbackStatus>(
    MEDIA_HUB_CHANNELS.feedbackSetDiagnostics,
    (_e, payload) => {
      setDiagnosticsEnabled(payload?.enabled !== false)
      return feedbackStatus()
    }
  )

  handle<{ includeLog?: boolean }, FeedbackPreview>(
    MEDIA_HUB_CHANNELS.feedbackPreview,
    (_e, payload) => feedbackPreview(payload?.includeLog === true)
  )
}
