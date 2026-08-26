// "A new episode of something you follow is out."
//
// Every competitor tells people this — Sonarr, Plex, Trakt and Simkl all do —
// and this app told them nothing. The permission was denied outright in
// main/index.ts, and correctly so: that denial covers RENDERER-initiated Web
// Notifications, which a compromised renderer could use to put arbitrary text
// on somebody's desktop. Electron's main-process Notification is a different
// thing entirely, driven by code that already decided what it wants to say, so
// it is the right side of that boundary to be on.
//
// OFF BY DEFAULT, and it stays that way until somebody turns it on. An app
// that starts notifying because it was updated has made a decision that was
// not its to make.

import { BrowserWindow, Notification } from 'electron'

import { upcomingEpisodes } from './calendar'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { activeProfileId } from './profiles'
import { readSettings } from './settingsStore'

/**
 * Where one profile's watermark lives.
 *
 * KEYED BY PROFILE, because the episodes it describes are. `upcomingEpisodes`
 * reads the active profile's tracked list, so a single shared key meant that
 * switching profiles found none of the new profile's episodes in the set and
 * announced every recent one — then overwrote the other profile's watermark on
 * the way out, so switching back announced everything again.
 *
 * catalog_cache is not itself profile-scoped (it holds facts about titles, not
 * about people), which is why the scoping has to be in the key rather than in
 * the table.
 *
 * `durable`, because a lost watermark means notifying about the same episode
 * twice — the failure people actually notice.
 */
function seenKey(profileId: string): string {
  return `notifications:seen:v1:${profileId}`
}
/** Ten years. This is a watermark, not a cache: it must never expire out from
 *  under the check and cause a re-announcement of everything. */
const SEEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

/**
 * How many go out at once.
 *
 * A show that drops a whole season at midnight would otherwise be twelve
 * notifications, which is not information — it is being shouted at. Past this
 * they are collapsed into one that says how many.
 */
const MAX_INDIVIDUAL = 3

export function notificationsEnabled(): boolean {
  return readSettings().notificationsEnabled === true
}

function show(title: string, body: string): void {
  // Not every platform has them, and a Linux build without a notification
  // daemon reports false rather than throwing on construction.
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: false })
  // Clicking brings the app forward, which is the only thing somebody could
  // reasonably want from it. Deliberately NOT deep-linking to the title: the
  // window may be showing a player, and yanking somebody out of what they are
  // watching to show them what they might watch is the wrong trade.
  notification.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  notification.show()
}

/**
 * Announces episodes that have aired since the last check.
 *
 * The watermark is a set of episode keys rather than a timestamp, and that
 * matters: air dates get corrected, sources backfill, and a title added today
 * arrives with a season of dates already in the past. A timestamp would
 * announce every one of them; a key set announces each episode exactly once,
 * whenever it happens to be noticed.
 *
 * The first run after switching this on announces NOTHING. It records what is
 * already there and stays quiet — the alternative is that turning on
 * notifications immediately fires one for every episode of every tracked show
 * from the past week, which is the single worst first impression this feature
 * could make. Because the watermark is per profile, that same courtesy applies
 * the first time each profile is checked rather than only the first time the
 * setting is turned on.
 */
export async function checkForNewEpisodes(now = new Date()): Promise<number> {
  if (!notificationsEnabled()) return 0

  const db = getDatabase()
  // Read once and reused for the write below: a profile switch between the two
  // would otherwise file this profile's episodes under the next one's key.
  const key = seenKey(activeProfileId())
  const stored = db.getCache<string[]>(key, { allowExpired: true })
  const seen = new Set(Array.isArray(stored) ? stored : [])
  const firstRun = stored === null

  const entries = await upcomingEpisodes(now)
  const today = now.toISOString().slice(0, 10)
  // Aired, not upcoming. Something out next week is on the calendar; only
  // something already out is worth interrupting somebody for.
  const aired = entries.filter((entry) => entry.airsOn <= today)

  const fresh = aired.filter(
    (entry) => !seen.has(`${entry.contentId}:${entry.season}:${entry.episode}`)
  )

  // Recorded whether or not anything is announced, including on the first run.
  const nextSeen = aired.map((entry) => `${entry.contentId}:${entry.season}:${entry.episode}`)
  db.putCache(key, nextSeen, SEEN_TTL_MS, { durable: true })

  if (firstRun || fresh.length === 0) return 0

  if (fresh.length <= MAX_INDIVIDUAL) {
    for (const entry of fresh) {
      const code = `S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`
      show(entry.title, entry.episodeTitle ? `${code} — ${entry.episodeTitle}` : `${code} is out.`)
    }
    return fresh.length
  }

  const titles = new Set(fresh.map((entry) => entry.title))
  show(
    `${fresh.length} new episodes`,
    titles.size === 1
      ? `${[...titles][0]} has ${fresh.length} new episodes.`
      : `Across ${titles.size} shows you follow.`
  )
  return fresh.length
}

/** Wrapped so a failure is logged rather than taking the heartbeat down. */
export async function runNewEpisodeCheck(): Promise<void> {
  try {
    await checkForNewEpisodes()
  } catch (error) {
    logError('job:new-episodes', error)
  }
}
