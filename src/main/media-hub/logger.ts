// Ported from r3v07v3r-media-hub's src/main.cjs (logError/redactUrls). A
// tiny best-effort file logger for the media-hub backend's main-process
// errors — intentionally not wired into any broader logging framework the
// rest of this project might add later, to keep this port self-contained.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function logPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'media-hub.log')
}

/** Strips URLs out of a string before it's logged — VLC's stderr in particular can echo the playback URL (which carries a bearer-style proxy token). */
export function redactUrls(value: unknown): string {
  return String(value).replace(/https?:\/\/\S+/gi, '[redacted-url]')
}

// Beyond full URLs (redactUrls above), an error message can carry a bare
// token/secret on its own — a failed fetch sometimes echoes a header value,
// and Simkl/MAL/TorBox error bodies occasionally include the query string
// that was sent. Each pattern matches a "key: value"/"key=value" pair (or a
// bare bearer token) and keeps the key name but blanks the value, so the
// log still says *what* failed without carrying the credential that did.
//
// Order matters: "Authorization: Bearer abc123" needs its *whole* value
// redacted, not just the first whitespace-delimited word ("Bearer") — the
// bearer-token pattern has to run before the header-line pattern, or the
// header pattern's `\S+` (one token only) consumes "Bearer" and leaves the
// actual token dangling in plain text right after "[redacted]". Verified
// live against that exact string before landing this ordering.
const SECRET_PATTERNS: RegExp[] = [
  /\b(bearer)(\s+)[A-Za-z0-9._-]+/gi,
  /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|invite[_-]?key|client[_-]?secret)(\s*[=:]\s*)["']?[^\s"'&]+/gi,
  /\b(authorization|cookie|set-cookie)(\s*:\s*).*/gi
]

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (_match, key: string, sep: string) => `${key}${sep}[redacted]`),
    value
  )
}

/** Best-effort append-only error log. Never throws — logging must not be able to break the feature it's observing. Every line is redacted before it touches disk — this is the one choke point every logError call goes through, so a call site doesn't have to remember to do it itself (see redactUrls' one pre-existing manual use in playbackSession.ts, which this makes redundant but harmless). */
export function logError(scope: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const safeMessage = redactSecrets(redactUrls(message))
    const line = `${new Date().toISOString()} [${scope}] ${safeMessage}\n`
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), line)
  } catch {
    // Logging must never throw into the caller.
  }
}
