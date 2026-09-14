// Ported from r3v07v3r-media-hub's src/mal.cjs. Pure PKCE-URL builder and
// MyAnimeList list-sync payload normalizers/reconciliation logic — no I/O
// here (the OAuth flow and fetch calls live in the orchestration layer that
// wires this in). Field names in the un-normalized shapes (`node`,
// `list_status`, `num_episodes_watched`) mirror MAL's REST API exactly.

import type {
  HistoryEntry,
  MalReconcilePreview,
  MalReconcileRatingToLocal,
  MalReconcileToLocal,
  MalReconcileToMal
} from '../../shared/media-hub/types'

/**
 * Builds the MAL v1 OAuth authorize URL. MAL's PKCE implementation only
 * supports the 'plain' challenge method, so the code verifier is sent
 * as-is as the code_challenge (no S256 hashing) — this is MAL's
 * requirement, not a shortcut taken here.
 */
export function buildAuthorizeUrl(
  clientId: string,
  state: string,
  codeVerifier: string,
  redirectUri: string
): string {
  const url = new URL('https://myanimelist.net/v1/oauth2/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', codeVerifier)
  url.searchParams.set('code_challenge_method', 'plain')
  return url.toString()
}

/**
 * Normalized MAL anime-list entry, before the orchestration layer merges in
 * a matched `kitsuId` (see computeReconciliation below, which accepts the
 * merged shape). Deliberately narrower than any single types.ts shape.
 */
export interface MalListEntry {
  malId: number
  title: string
  status: string
  watchedEpisodes: number
  /** MAL's 1-10 user score, 0 when unrated — same range/meaning as this app's own rating. */
  score: number
}

/** Normalizes one raw `{node, list_status}` entry from MAL's anime list API response. */
export function normalizeMalEntry(entry: {
  node?: { id?: unknown; title?: unknown }
  list_status?: { status?: unknown; num_episodes_watched?: unknown; score?: unknown }
}): MalListEntry {
  const node = entry?.node || {}
  const status = entry?.list_status || {}
  return {
    malId: Number(node.id) || 0,
    title: String(node.title || 'Untitled'),
    status: String(status.status || ''),
    watchedEpisodes: Number(status.num_episodes_watched) || 0,
    score: Number(status.score) || 0
  }
}

/**
 * Counts distinct watched episodes per kitsu-id from this app's local
 * history, so they can be compared against MAL's per-title episode counts.
 * Only `kitsu:*` ids are considered since MAL entries are matched to local
 * items via Kitsu id. Uses a Set of `season:episode` keys (not a running
 * count) so repeated marks of the same episode don't double-count.
 */
export function localWatchedEpisodeCounts(history: HistoryEntry[]): Record<string, number> {
  const bucket = new Map<string, Set<string>>()
  for (const entry of history || []) {
    const id = String(entry.id || '')
    if (!id.startsWith('kitsu:') || !Number.isFinite(entry.episode)) continue
    if (!bucket.has(id)) bucket.set(id, new Set())
    bucket.get(id)!.add(`${Number.isFinite(entry.season) ? entry.season : 1}:${entry.episode}`)
  }
  const counts: Record<string, number> = {}
  for (const [id, set] of bucket) counts[id] = set.size
  return counts
}

/**
 * MAL treats an episode count and list status as separate fields. Keep them
 * aligned whenever this app knows the title's total: reaching that total
 * moves it out of the Watching list, while unmarking an episode moves it
 * back. With no reliable total, leave status alone rather than guessing.
 */
export function malStatusForProgress(
  watchedEpisodes: number,
  totalEpisodes: number | undefined
): 'completed' | 'watching' | undefined {
  if (!Number.isFinite(totalEpisodes) || !totalEpisodes || totalEpisodes < 0) return undefined
  return watchedEpisodes >= totalEpisodes ? 'completed' : 'watching'
}

/**
 * Diffs MAL's remote watch progress (and ratings) against local state per
 * title. Entries MAL couldn't be matched to a local Kitsu id (`kitsuId`
 * missing) are reported as `unmatched` rather than silently dropped. When
 * MAL is ahead, the gap becomes a toLocal catch-up range; when local is
 * ahead, it becomes a toMal push. Entries in sync produce no action either
 * way.
 *
 * `targetId` (set by the caller via catalog.ts's resolveAnimeGroupTarget)
 * is the canonical id a rating belongs to — for a merged franchise this
 * differs from `kitsuId`, which is whichever sibling MAL matched. Ratings
 * are gap-filled only, same as db.importRatings: a title already rated
 * locally keeps that rating rather than being overwritten by MAL's.
 */
export function computeReconciliation(
  malEntries: (MalListEntry & { kitsuId?: string; targetId?: string })[],
  localProgressByKitsuId: Record<string, number>,
  localRatingsByTargetId: Record<string, number> = {}
): MalReconcilePreview {
  const toMal: MalReconcileToMal[] = []
  const toLocal: MalReconcileToLocal[] = []
  const ratingsToLocal: MalReconcileRatingToLocal[] = []
  const unmatched: unknown[] = []
  for (const entry of malEntries || []) {
    if (!entry.kitsuId) {
      unmatched.push(entry)
      continue
    }
    const localCount = Number(localProgressByKitsuId[entry.kitsuId]) || 0
    const malCount = Number(entry.watchedEpisodes) || 0
    if (malCount > localCount) {
      toLocal.push({
        kitsuId: entry.kitsuId,
        title: entry.title,
        fromEpisode: localCount + 1,
        toEpisode: malCount
      })
    } else if (localCount > malCount) {
      toMal.push({
        kitsuId: entry.kitsuId,
        malId: entry.malId,
        title: entry.title,
        watchedEpisodes: localCount
      })
    }
    if (entry.score > 0 && entry.targetId && !(entry.targetId in localRatingsByTargetId)) {
      ratingsToLocal.push({ targetId: entry.targetId, title: entry.title, score: entry.score })
    }
  }
  return { toMal, toLocal, unmatched, ratingsToLocal }
}

/** The list a MAL entry sits on, as far as this app ever sets it. */
export type MalListStatus = 'completed' | 'watching' | 'plan_to_watch'

/**
 * One MAL entry told its new progress: the Kitsu id that names the entry
 * (a group member's own, never the canonical's standing in for it), the
 * count, and the status when one follows from it.
 */
export interface MalEntryPush {
  id: string
  watchedEpisodes: number
  status?: MalListStatus
}

/**
 * Distinct watched episodes of one title, per season. MAL keeps a season
 * per entry where this app keeps one show, so a grouped title's push needs
 * its count season by season, not the id's sum.
 */
export function localSeasonEpisodeCounts(history: HistoryEntry[], id: string): Map<number, number> {
  const seen = new Map<number, Set<number>>()
  for (const entry of history || []) {
    if (String(entry.id) !== id || !Number.isFinite(entry.episode)) continue
    const season = Number.isFinite(entry.season) ? (entry.season as number) : 1
    if (!seen.has(season)) seen.set(season, new Set())
    seen.get(season)!.add(entry.episode as number)
  }
  return new Map([...seen].map(([season, episodes]) => [season, episodes.size]))
}

/**
 * The pushes one title's change makes at MAL, one per entry.
 *
 * A title with `members` is a grouped anime: one show here, several
 * entries there, one per season. Its history rows are keyed on the
 * canonical id with the member's season number — member k of the group
 * is season k+1 (see animeSeasons.ts's buildAnimeGroupIndexes) — so the
 * change goes to the members owning the seasons it touched, each with
 * that season's count and, when the caller knows it, that season's total.
 * Never the group's sum on the first season's entry, which is what one
 * push for the canonical id amounted to, and never the group's total in
 * place of a member's own: a member whose total is unknown gets its count
 * and keeps whatever status it had. Seasons the change did not touch are
 * left alone — MAL's PATCH creates an entry that is missing, and a season
 * nobody watched must not appear on the list at zero. An ungrouped title
 * is one entry, counted over every row.
 *
 * A zero count picks no status of its own — only one chosen explicitly (a
 * planned title's clear says plan_to_watch); see pushMalProgress.
 */
export function planMalPushes(
  history: HistoryEntry[],
  title: { id: string; members?: readonly string[]; totalEpisodes?: number },
  change: {
    seasons: Iterable<number>
    seasonTotals?: ReadonlyMap<number, number>
    status?: 'plan_to_watch'
  }
): MalEntryPush[] {
  const entry = (
    id: string,
    watchedEpisodes: number,
    totalEpisodes: number | undefined
  ): MalEntryPush => {
    const status =
      watchedEpisodes === 0 ? change.status : malStatusForProgress(watchedEpisodes, totalEpisodes)
    return status ? { id, watchedEpisodes, status } : { id, watchedEpisodes }
  }
  if (!title.members?.length) {
    return [entry(title.id, localWatchedEpisodeCounts(history)[title.id] || 0, title.totalEpisodes)]
  }
  const counts = localSeasonEpisodeCounts(history, title.id)
  const pushes: MalEntryPush[] = []
  for (const season of [...new Set(change.seasons)].sort((a, b) => a - b)) {
    const id = title.members[season - 1]
    if (!id) continue
    pushes.push(entry(id, counts.get(season) ?? 0, change.seasonTotals?.get(season)))
  }
  return pushes
}
