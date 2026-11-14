// Testers' reports: typed feedback, crashes, errors and repeated actions,
// queued on disk and sent to the feedback Worker (feedback-worker/), which
// keeps them in a private D1 database.
//
// Everything is sanitised HERE, before it is queued, so not even the queue
// file holds an account name or a token: see src/shared/feedback/sanitize.ts.
// The Worker cleans it again on arrival.
//
// The queue is written synchronously on every change. A crash report is
// queued from inside the crash; the process may be gone a moment later,
// and the report goes out on the next launch.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeText, sanitizeValue } from '../../../shared/feedback/sanitize'
import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_LIMITS,
  type FeedbackCategory,
  type FeedbackKind,
  type FeedbackPreview,
  type FeedbackReport,
  type FeedbackStatus
} from '../../../shared/feedback/types'
import { electronModule } from '../electronModule'
import { readLogTail } from '../logger'
import { readSettings, writeSettings } from '../settingsStore'

const QUEUE_LIMIT = 100
/** The same problem again within this is counted on the queued report,
 *  not queued twice. */
const DEDUPE_MS = 10 * 60_000
const SEND_TIMEOUT_MS = 15_000
const FLUSH_EVERY_MS = 15 * 60_000

interface QueuedReport {
  report: FeedbackReport
  queuedAt: number
}

let queue: QueuedReport[] | null = null
let lastSentAt: string | null = null
let lastError: string | null = null
let flushing: Promise<void> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let heldUntil = 0

function feedbackDir(): string {
  return path.join(electronModule().app.getPath('userData'), 'feedback')
}

function queueFile(): string {
  return path.join(feedbackDir(), 'queue.json')
}

function endpoint(): string {
  return process.env['R3_FEEDBACK_URL'] || FEEDBACK_ENDPOINT
}

function appVersion(): string {
  try {
    return electronModule().app.getVersion()
  } catch {
    return 'unknown'
  }
}

export function diagnosticsEnabled(): boolean {
  return readSettings().diagnosticsEnabled !== false
}

export function setDiagnosticsEnabled(on: boolean): void {
  const settings = readSettings()
  if (on) delete settings.diagnosticsEnabled
  else settings.diagnosticsEnabled = false
  writeSettings(settings)
  // Off means off: what was waiting goes too, except typed feedback.
  if (!on) {
    queue = loadQueue().filter((item) => item.report.kind === 'feedback')
    saveQueue()
  }
}

function installId(): string {
  const settings = readSettings()
  if (settings.feedbackInstallId) return settings.feedbackInstallId
  settings.feedbackInstallId = crypto.randomUUID()
  writeSettings(settings)
  return settings.feedbackInstallId
}

/** The names the patterns cannot guess: this account's and this computer's. */
function knownNames(): { user: string[]; computer: string[] } {
  const user: string[] = []
  const computer: string[] = []
  try {
    user.push(os.userInfo().username)
  } catch {
    // No account name to hide.
  }
  for (const key of ['USERNAME', 'USER']) if (process.env[key]) user.push(process.env[key]!)
  try {
    computer.push(os.hostname())
  } catch {
    // No machine name to hide.
  }
  if (process.env['COMPUTERNAME']) computer.push(process.env['COMPUTERNAME'])
  if (process.env['USERDOMAIN']) computer.push(process.env['USERDOMAIN'])
  return { user, computer }
}

export function clean(value: unknown, maxLength?: number): string {
  return sanitizeText(value, { names: knownNames(), maxLength })
}

function platformLine(): string {
  return `${process.platform} ${process.arch} ${os.release()}`
}

/** A short stable id for "the same problem": the kind, the message with
 *  numbers taken out, and the top frames without line numbers. */
export function fingerprintOf(kind: FeedbackKind, title: string, stack = ''): string {
  const frames = stack
    .split('\n')
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 3)
    .map((line) => line.replace(/:\d+(:\d+)?\)?$/, '').replace(/\(.*[\\/]/, '('))
  const basis = [kind, title.replace(/\d+/g, '#').slice(0, 160), ...frames].join('|')
  return `${kind}:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`
}

/** The end of the app log, cleaned, for attaching or previewing. */
export function cleanLogTail(): string {
  return clean(readLogTail(FEEDBACK_LIMITS.log * 2), FEEDBACK_LIMITS.log)
}

function loadQueue(): QueuedReport[] {
  if (queue) return queue
  try {
    const parsed = JSON.parse(fs.readFileSync(queueFile(), 'utf8')) as unknown
    queue = Array.isArray(parsed) ? (parsed as QueuedReport[]) : []
  } catch {
    queue = []
  }
  return queue
}

function saveQueue(): void {
  try {
    const file = queueFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(queue ?? []))
    fs.renameSync(temporary, file)
  } catch {
    // A report that cannot be saved is lost; the app goes on.
  }
}

export interface ProblemInput {
  kind: Exclude<FeedbackKind, 'feedback'>
  title: string
  body?: string
  stack?: string
  context?: Record<string, string | number | boolean>
  /** Attach the end of the log. On for crashes and unclean exits. */
  withLog?: boolean
  fingerprint?: string
}

/** Queues an automatic report, if diagnostics are on. Never throws. */
export function reportProblem(input: ProblemInput): void {
  try {
    if (!diagnosticsEnabled()) return
    const title = clean(input.title, FEEDBACK_LIMITS.title) || input.kind
    const stack = input.stack ?? ''
    const fingerprint = input.fingerprint ?? fingerprintOf(input.kind, title, stack)
    const items = loadQueue()
    const now = Date.now()
    const twin = items.find(
      (item) => item.report.fingerprint === fingerprint && now - item.queuedAt < DEDUPE_MS
    )
    if (twin) {
      const context = (twin.report.context ??= {})
      context['repeats'] = Number(context['repeats'] ?? 1) + 1
      saveQueue()
      return
    }
    enqueue({
      v: 1,
      kind: input.kind,
      installId: installId(),
      appVersion: appVersion(),
      platform: platformLine(),
      occurredAt: new Date(now).toISOString(),
      title,
      body: clean([input.body, stack].filter(Boolean).join('\n\n'), FEEDBACK_LIMITS.body),
      fingerprint,
      context: input.context
        ? sanitizeValue(input.context, {
            names: knownNames(),
            maxLength: FEEDBACK_LIMITS.contextValue
          })
        : undefined,
      log: input.withLog ? cleanLogTail() || undefined : undefined
    })
  } catch {
    // Reporting must never be the next crash.
  }
}

export interface FeedbackInput {
  category: FeedbackCategory
  text: string
  includeLog: boolean
  context?: Record<string, string | number | boolean>
}

/** Queues somebody's typed feedback and tries to send it at once. Sent
 *  whether or not automatic diagnostics are on. */
export async function sendFeedback(input: FeedbackInput): Promise<{ sent: boolean }> {
  const body = clean(input.text, FEEDBACK_LIMITS.body).trim()
  if (!body) throw new Error('Write something first.')
  const firstLine = body.split('\n')[0]
  enqueue({
    v: 1,
    kind: 'feedback',
    category: input.category,
    installId: installId(),
    appVersion: appVersion(),
    platform: platformLine(),
    occurredAt: new Date().toISOString(),
    title: firstLine.slice(0, FEEDBACK_LIMITS.title),
    body,
    context: input.context
      ? sanitizeValue(input.context, {
          names: knownNames(),
          maxLength: FEEDBACK_LIMITS.contextValue
        })
      : undefined,
    log: input.includeLog ? cleanLogTail() || undefined : undefined
  })
  heldUntil = 0
  await flushFeedback()
  return {
    sent: !loadQueue().some((item) => item.report.kind === 'feedback' && item.report.body === body)
  }
}

function enqueue(report: FeedbackReport): void {
  const items = loadQueue()
  items.push({ report, queuedAt: Date.now() })
  // Over the limit, the oldest automatic report goes first; typed
  // feedback is the last thing dropped.
  while (items.length > QUEUE_LIMIT) {
    const automatic = items.findIndex((item) => item.report.kind !== 'feedback')
    items.splice(automatic >= 0 ? automatic : 0, 1)
  }
  saveQueue()
  scheduleFlush(5_000)
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushFeedback()
  }, delayMs)
  flushTimer.unref?.()
}

/** Sends what is queued, a batch at a time. Never rejects. */
export function flushFeedback(): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    try {
      while (Date.now() >= heldUntil) {
        const items = loadQueue()
        if (items.length === 0) return
        const batch = items.slice(0, FEEDBACK_LIMITS.batch)
        const response = await fetch(endpoint(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': `r3-media-hub/${appVersion()}`
          },
          body: JSON.stringify({ reports: batch.map((item) => item.report) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        })
        if (response.status === 429) {
          lastError = 'The feedback server asked to slow down; trying again later.'
          heldUntil = Date.now() + 60 * 60_000
          return
        }
        if (!response.ok && response.status !== 400) {
          lastError = `The feedback server answered ${response.status}.`
          return
        }
        // 200: stored. 400: malformed, and resending it would be refused
        // again. Either way this batch is done.
        queue = loadQueue().filter((item) => !batch.includes(item))
        saveQueue()
        lastSentAt = new Date().toISOString()
        lastError = null
      }
    } catch {
      lastError = 'Could not reach the feedback server; the reports wait and go later.'
    } finally {
      flushing = null
    }
  })()
  return flushing
}

export function feedbackStatus(): FeedbackStatus {
  return {
    diagnosticsEnabled: diagnosticsEnabled(),
    pending: loadQueue().length,
    lastSentAt,
    lastError
  }
}

/** What a report from this install carries besides the text, for the
 *  Feedback section to show before anything is sent. */
export function feedbackPreview(includeLog: boolean): FeedbackPreview {
  return {
    appVersion: appVersion(),
    platform: platformLine(),
    log: includeLog ? cleanLogTail() : ''
  }
}

/** Starts the regular send: soon after launch, then every quarter hour. */
export function startFeedbackSender(): void {
  scheduleFlush(30_000)
  const timer = setInterval(() => void flushFeedback(), FLUSH_EVERY_MS)
  timer.unref?.()
}
