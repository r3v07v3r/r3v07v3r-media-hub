// R3 Media Hub's feedback intake. The app (src/main/media-hub/feedback/)
// POSTs batches of reports here; this checks them, cleans them a second
// time, and stores them in D1.
//
// WRITE-ONLY. There is no route that returns a stored report, so the only
// way to read them is with the Cloudflare account (`wrangler d1 execute`,
// the dashboard, or the D1 API). The URL is in the app's public source, so
// anybody can find it; what they cannot do is read anything back through it.
//
// The app has already sanitised each report (src/shared/feedback/sanitize.ts);
// running the same rules again here means a report from an older build, or a
// pattern that build missed, is still cleaned before it is kept.

import { sanitizeText, sanitizeValue } from '../../src/shared/feedback/sanitize'
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
  type FeedbackCategory,
  type FeedbackKind
} from '../../src/shared/feedback/types'

export interface Env {
  DB: D1Database
  /** Per-IP request limit. The address is the limiter's key only; it is
   *  never stored. */
  REPORT_LIMITER: RateLimit
}

/** Reports one install may store per day. A crash loop on one machine
 *  should not be able to fill the database. */
const DAILY_PER_INSTALL = 300

/** Full logs are the heavy part of a row; they are dropped after this, the
 *  rest of the report kept. */
const LOG_RETENTION_DAYS = 60
const REPORT_RETENTION_DAYS = 365

const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/

interface CleanReport {
  kind: FeedbackKind
  category: FeedbackCategory | null
  installId: string
  appVersion: string
  platform: string
  occurredAt: string | null
  fingerprint: string | null
  title: string
  body: string
  context: string | null
  log: string | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}

function text(value: unknown, max: number): string {
  return sanitizeText(typeof value === 'string' ? value : '', { maxLength: max }).trim()
}

/** One incoming report, checked and cleaned, or null if it is not one. */
function clean(raw: unknown): CleanReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return null
  if (!FEEDBACK_KINDS.includes(r.kind as FeedbackKind)) return null
  if (typeof r.installId !== 'string' || !INSTALL_ID.test(r.installId)) return null
  const title = text(r.title, FEEDBACK_LIMITS.title)
  if (!title) return null

  let context: string | null = null
  if (r.context && typeof r.context === 'object' && !Array.isArray(r.context)) {
    const kept: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(r.context as Record<string, unknown>).slice(
      0,
      FEEDBACK_LIMITS.contextKeys
    )) {
      if (typeof value === 'number' || typeof value === 'boolean') kept[key.slice(0, 40)] = value
      else if (typeof value === 'string')
        kept[key.slice(0, 40)] = value.slice(0, FEEDBACK_LIMITS.contextValue)
    }
    context = JSON.stringify(sanitizeValue(kept))
  }

  const occurred = typeof r.occurredAt === 'string' ? Date.parse(r.occurredAt) : NaN
  const fingerprint =
    typeof r.fingerprint === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(r.fingerprint)
      ? r.fingerprint
      : null

  return {
    kind: r.kind as FeedbackKind,
    category: FEEDBACK_CATEGORIES.includes(r.category as FeedbackCategory)
      ? (r.category as FeedbackCategory)
      : null,
    installId: r.installId,
    appVersion: text(r.appVersion, 40) || 'unknown',
    platform: text(r.platform, 80) || 'unknown',
    occurredAt: Number.isFinite(occurred) ? new Date(occurred).toISOString() : null,
    fingerprint,
    title,
    body: text(r.body, FEEDBACK_LIMITS.body),
    context,
    log: typeof r.log === 'string' && r.log ? text(r.log, FEEDBACK_LIMITS.log) : null
  }
}

async function takeReports(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const { success } = await env.REPORT_LIMITER.limit({ key: ip })
  if (!success) return json(429, { error: 'slow down' })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > FEEDBACK_LIMITS.requestBytes) return json(413, { error: 'too large' })
  const raw = await request.text()
  if (raw.length > FEEDBACK_LIMITS.requestBytes) return json(413, { error: 'too large' })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json(400, { error: 'not json' })
  }
  const list = (parsed as { reports?: unknown })?.reports
  if (!Array.isArray(list) || list.length === 0 || list.length > FEEDBACK_LIMITS.batch) {
    return json(400, { error: 'expected reports[1..20]' })
  }

  const reports = list.map(clean).filter((r): r is CleanReport => r !== null)
  if (reports.length === 0) return json(400, { error: 'no valid reports' })

  // One install per batch is what the app sends; a mixed batch is checked
  // against the first id's allowance, which is the stricter reading.
  const installId = reports[0].installId
  const today = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reports WHERE install_id = ? AND received_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`
  )
    .bind(installId)
    .first<{ n: number }>()
  const room = DAILY_PER_INSTALL - (today?.n ?? 0)
  if (room <= 0) return json(429, { error: 'daily limit' })

  const insert = env.DB.prepare(
    `INSERT INTO reports (occurred_at, kind, category, install_id, app_version, platform, fingerprint, title, body, context, log)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const kept = reports.slice(0, room)
  await env.DB.batch(
    kept.map((r) =>
      insert.bind(
        r.occurredAt,
        r.kind,
        r.category,
        r.installId,
        r.appVersion,
        r.platform,
        r.fingerprint,
        r.title,
        r.body,
        r.context,
        r.log
      )
    )
  )
  // `accepted` lets the app drop exactly what was stored from its queue;
  // anything rejected as malformed is dropped too, since resending it would
  // only be rejected again.
  return json(200, { accepted: kept.length, rejected: list.length - reports.length })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/v1/reports') {
      if (request.method !== 'POST') return json(405, { error: 'POST only' })
      try {
        return await takeReports(request, env)
      } catch {
        // Never echo the error: it could carry part of a report.
        return json(500, { error: 'not stored' })
      }
    }
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true })
    return json(404, { error: 'not found' })
  },

  /** Daily housekeeping: logs go after LOG_RETENTION_DAYS, reports after
   *  REPORT_RETENTION_DAYS. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE reports SET log = NULL WHERE log IS NOT NULL AND received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
      ).bind(`-${LOG_RETENTION_DAYS} days`),
      env.DB.prepare(
        `DELETE FROM reports WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
      ).bind(`-${REPORT_RETENTION_DAYS} days`)
    ])
  }
} satisfies ExportedHandler<Env>
