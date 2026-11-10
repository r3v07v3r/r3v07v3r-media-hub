/**
 * "The latest request wins", for the playback path.
 *
 * There is one stream cache session and one mpv, but nothing used to stop
 * two requests for them overlapping. A play the window had already given up
 * on (Cancel on the spinner, or a second press of Play, both of which send
 * playback:stop) kept running here: its copy loop read the stopped session
 * as "that copy wouldn't open" and went on to the next copy, while the new
 * request opened its own. Each start then tore down the other's session, the
 * player was handed a cache URL whose token had just been revoked ("Playback
 * requires a valid HTTPS media URL"), and the copy that did open sat waiting
 * on chunks a newer start had cleared ("No bytes could be fetched ... at
 * byte 0"). Found on Solo Leveling S01E05, 2026-11-09.
 *
 * A ticket is taken when a request begins. Taking the next one, or calling
 * `supersede()` (a stop), makes every earlier ticket stale; the holder checks
 * after each await and gives up with PlaybackSupersededError instead of
 * touching state that now belongs to someone else.
 */
export class PlaybackSupersededError extends Error {
  constructor() {
    super('This playback was replaced by a newer one.')
    this.name = 'PlaybackSupersededError'
  }
}

export interface Supersession {
  /** Starts a request. The returned check is true until a later `take()`
   *  or a `supersede()`. */
  take(): () => boolean
  /** Makes every ticket taken so far stale. */
  supersede(): void
}

export function createSupersession(): Supersession {
  let latest = 0
  return {
    take() {
      const mine = ++latest
      return () => latest === mine
    },
    supersede() {
      latest += 1
    }
  }
}

/** Throws PlaybackSupersededError when `current` has gone stale. */
export function assertCurrent(current: () => boolean): void {
  if (!current()) throw new PlaybackSupersededError()
}

export function isSuperseded(error: unknown): boolean {
  return (
    error instanceof PlaybackSupersededError ||
    (error instanceof Error && error.name === 'PlaybackSupersededError')
  )
}
