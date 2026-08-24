// Ported from r3v07v3r-media-hub's src/main.cjs (logError/redactUrls). A
// tiny best-effort file logger for the media-hub backend's main-process
// errors — intentionally not wired into any broader logging framework the
// rest of this project might add later, to keep this port self-contained.

import fs from 'node:fs'
import path from 'node:path'

/**
 * Where the log lives. Electron is resolved lazily, on the first line
 * actually written, rather than imported at the top of this file.
 *
 * The reason is that a top-level `import { app } from 'electron'` throws
 * at IMPORT time when the Electron binary is absent, and that takes down
 * everything that merely mentions this module — however far away, and
 * however little it wanted a log file. CI installs with `npm ci
 * --ignore-scripts`, which by design never downloads that binary, so the
 * pure-logic tests were failing on the import chain
 * animeCatalogStorage.test -> animeSeasons -> logger -> electron before
 * running a single assertion.
 *
 * Lazily, the same absence is just a throw inside logError's existing
 * catch, which degrades to "no log file written" — exactly the contract
 * this module already promises ("Never throws — logging must not be able
 * to break the feature it's observing"). Nothing changes for the packaged
 * app, where the binary is always there and this resolves on the first
 * error logged.
 */
function logPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
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

/** How many stack frames to keep. Enough to name the throwing call and its
 *  caller without turning the log into a wall of Electron internals. */
const STACK_FRAMES = 6

/**
 * Best-effort append-only error log. Never throws — logging must not be able to
 * break the feature it's observing. Every line is redacted before it touches
 * disk — this is the one choke point every logError call goes through, so a
 * call site doesn't have to remember to do it itself.
 *
 * Records the error's TYPE and STACK, not just its message. This is not
 * gold-plating: a real playback failure was reported as the single line
 * `[mediahub:play:stream] error accessing property` — a message thrown from
 * Electron's native layer that appears in no JavaScript we ship or depend on,
 * with nothing to say which of the dozen native calls in that handler raised
 * it. A message alone is not diagnosable when the message isn't ours.
 */
export function logError(scope: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    // `Error` for a plain throw is noise; anything else (TypeError, RangeError,
    // an Electron-specific subclass) immediately narrows the search.
    const kind =
      error instanceof Error && error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    const safeMessage = redactSecrets(redactUrls(`${kind}${message}`))
    let line = `${new Date().toISOString()} [${scope}] ${safeMessage}\n`
    if (error instanceof Error && error.stack) {
      const frames = error.stack
        .split('\n')
        .slice(1, 1 + STACK_FRAMES)
        .map((frame) => `    ${redactSecrets(redactUrls(frame.trim()))}`)
        .join('\n')
      if (frames) line += `${frames}\n`
    }
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), line)
  } catch {
    // Logging must never throw into the caller.
  }
}
