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

/** Best-effort append-only error log. Never throws — logging must not be able to break the feature it's observing. */
export function logError(scope: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const line = `${new Date().toISOString()} [${scope}] ${message}\n`
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), line)
  } catch {
    // Logging must never throw into the caller.
  }
}
