// One report from a tester's install to the feedback Worker
// (feedback-worker/). Shared by the app, which builds and sanitises it, and
// the Worker, which checks and stores it — so the two cannot disagree about
// the shape or the limits.

export type FeedbackKind =
  /** Somebody typed it in the Feedback section. */
  | 'feedback'
  /** The main process threw and nothing caught it, or a renderer or helper
   *  process died. */
  | 'crash'
  /** Something went wrong that the app noticed and survived: a render
   *  error, an unhandled rejection, the player not answering. */
  | 'error'
  /** The same action done again and again in a short time — a sign
   *  something did not work the first time. */
  | 'friction'
  /** The app did not shut down cleanly last time: killed while frozen,
   *  power loss, or a crash too hard to report. */
  | 'unclean-exit'

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  'feedback',
  'crash',
  'error',
  'friction',
  'unclean-exit'
]

export type FeedbackCategory = 'bug' | 'idea' | 'other'
export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = ['bug', 'idea', 'other']

export interface FeedbackReport {
  v: 1
  kind: FeedbackKind
  /** Random per install, made on first use. Lets "seen on 4 machines" be
   *  counted without saying whose. */
  installId: string
  appVersion: string
  /** "win32 x64 10.0.26300" — no machine name. */
  platform: string
  occurredAt: string
  /** One line: the error message, the repeated control, or the start of
   *  the typed feedback. */
  title: string
  /** The stack, or the full typed text. */
  body: string
  /** Groups reports of the same problem. Absent for typed feedback. */
  fingerprint?: string
  category?: FeedbackCategory
  /** Small facts: the screen, how many repeats, which process died. */
  context?: Record<string, string | number | boolean>
  /** The end of the app log, when attached. */
  log?: string
}

export const FEEDBACK_LIMITS = {
  title: 200,
  body: 8_000,
  fingerprint: 64,
  log: 24_000,
  contextKeys: 20,
  contextValue: 300,
  /** Reports per POST. */
  batch: 20,
  /** Bytes per POST. */
  requestBytes: 256_000
} as const

/** The Worker the app sends to. Overridable for a local `wrangler dev`. */
export const FEEDBACK_ENDPOINT = 'https://r3-feedback.unit.workers.dev/v1/reports'

/** What the Feedback section shows about this install's reporting. */
export interface FeedbackStatus {
  diagnosticsEnabled: boolean
  /** Reports waiting to go: offline, or sent too fast. */
  pending: number
  lastSentAt: string | null
  lastError: string | null
}

/** What goes with a report besides its text, shown before sending. */
export interface FeedbackPreview {
  appVersion: string
  platform: string
  /** The end of the app log as it would be sent: already cleaned. */
  log: string
}

/** A problem the renderer saw: a render error, or a run of repeated clicks. */
export interface RendererProblem {
  kind: 'error' | 'friction'
  title: string
  stack?: string
  fingerprint?: string
  context?: Record<string, string | number | boolean>
}
