// New (not a direct port) — the original app created a single module-level
// `mediaDb` in main.cjs's app.whenReady() and every handler in that same
// file closed over it directly. This port's handlers live across several
// modules (torbox.ts, catalog.ts, tracking.ts, malSync.ts), so the
// singleton is exposed through this tiny accessor module instead — set
// once from src/main/index.ts after createDatabase() resolves, read by
// every module that needs it.

import type { MediaHubDatabase } from './database'

let database: MediaHubDatabase | null = null

export function setDatabase(db: MediaHubDatabase): void {
  database = db
}

/** Throws if called before src/main/index.ts has initialized the database (app.whenReady) — every IPC handler that touches this is only ever invoked well after that point, so this is a programmer-error guard, not a runtime condition callers need to handle. */
export function getDatabase(): MediaHubDatabase {
  if (!database) {
    throw new Error('Media-hub database has not been initialized yet.')
  }
  return database
}
