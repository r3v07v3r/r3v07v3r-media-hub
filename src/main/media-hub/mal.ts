// Ported from r3v07v3r-media-hub's src/mal.cjs. Pure PKCE-URL builder and
// MyAnimeList list-sync payload normalizers/reconciliation logic — no I/O
// here (the OAuth flow and fetch calls live in the orchestration layer that
// wires this in). Field names in the un-normalized shapes (`node`,
// `list_status`, `num_episodes_watched`) mirror MAL's REST API exactly.

import type {
  HistoryEntry,
  MalReconcilePreview,
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
}

/** Normalizes one raw `{node, list_status}` entry from MAL's anime list API response. */
export function normalizeMalEntry(entry: {
  node?: { id?: unknown; title?: unknown }
  list_status?: { status?: unknown; num_episodes_watched?: unknown }
}): MalListEntry {
  const node = entry?.node || {}
  const status = entry?.list_status || {}
  return {
    malId: Number(node.id) || 0,
    title: String(node.title || 'Untitled'),
    status: String(status.status || ''),
    watchedEpisodes: Number(status.num_episodes_watched) || 0
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
    bucket.get(id)!.add(`${entry.season || 1}:${entry.episode}`)
  }
  const counts: Record<string, number> = {}
  for (const [id, set] of bucket) counts[id] = set.size
  return counts
}

/**
 * Diffs MAL's remote watch progress against local watch progress per title.
 * Entries MAL couldn't be matched to a local Kitsu id (`kitsuId` missing)
 * are reported as `unmatched` rather than silently dropped. When MAL is
 * ahead, the gap becomes a toLocal catch-up range; when local is ahead,
 * it becomes a toMal push. Entries in sync produce no action either way.
 */
export function computeReconciliation(
  malEntries: (MalListEntry & { kitsuId?: string })[],
  localProgressByKitsuId: Record<string, number>
): MalReconcilePreview {
  const toMal: MalReconcileToMal[] = []
  const toLocal: MalReconcileToLocal[] = []
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
  }
  return { toMal, toLocal, unmatched }
}
