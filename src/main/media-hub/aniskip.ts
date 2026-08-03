// Skip Intro/Credits for anime, via aniskip.dev's community-submitted skip
// times. Confirmed real and free (no key required) directly against its
// live API: `GET /v2/skip-times/{malId}/{episode}?types=op&types=ed&
// episodeLength={seconds}` returns `{found, results: [{interval:{startTime,
// endTime}, skipType: 'op'|'ed', episodeLength}], ...}` on a match, or a 404
// with `{found:false}` when nothing matches — the latter is a normal,
// expected outcome (no submission for this episode, or none close enough
// to the passed episodeLength), not a real error.
//
// Aniskip keys everything by MyAnimeList id, but this app's catalog/
// playback identity for anime is Kitsu id (see catalog.ts/torbox.ts) — the
// bridge is Kitsu's own `/mappings` endpoint, the same one
// animeSeasons.ts's kitsuTvdbMapping already uses for a different external
// site, confirmed live to also carry a `myanimelist/anime` entry. Fetched
// and cached separately from that function's own cache entry (a second,
// independent request to `/mappings`) rather than refactored to share one
// call — see this codebase's established "small local duplication over a
// shared cross-module utility" convention; this is a 30-day-cached, once-
// per-title cost either way.
//
// No equivalent skip-time source exists for movies/series (Aniskip is
// anime-only) — this feature is deliberately anime-only, not a gap left to
// fill in later.

import { fetchJson, type HttpError } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import type { RawApiPayload } from './core'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { SkipInterval, SkipTimes } from '../../shared/media-hub/types'

/** Cached (30d — this cross-reference essentially never changes once published) Kitsu-to-MyAnimeList id bridge. Returns null when Kitsu has no myanimelist mapping for this id. `kitsuId` may be this app's catalog-id form (`kitsu:1234`, see catalog.ts/torbox.ts) or the bare numeric id Kitsu's own API expects — either works, mirroring animeSeasons.ts's `item.id.replace(/^kitsu:/, '')` at its own kitsuTvdbMapping call sites. */
export async function kitsuMalId(kitsuId: string): Promise<number | null> {
  const bareId = kitsuId.replace(/^kitsu:/, '')
  const key = `kitsu:mal:${bareId}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached > 0 ? cached : null

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(bareId)}/mappings`
    )
    const entry = (result.data || []).find(
      (x: RawApiPayload) => x.attributes?.externalSite === 'myanimelist/anime'
    )
    const id = Number(entry?.attributes?.externalId)
    const value = Number.isInteger(id) && id > 0 ? id : -1
    db.putCache(key, value, 30 * 24 * 60 * 60 * 1000)
    return value > 0 ? value : null
  } catch (error) {
    logError('anime:mal-id', error)
    return null
  }
}

interface AniskipResult {
  interval: { startTime: number; endTime: number }
  skipType: 'op' | 'ed' | 'mixed-op' | 'mixed-ed' | 'recap'
}

interface AniskipResponse {
  found: boolean
  results?: AniskipResult[]
}

/**
 * Real opening/ending skip windows for one anime episode, or null if none
 * are known for it (a normal outcome — most episodes of most shows have no
 * community submission yet). `episodeLengthSeconds` should be the actual
 * playing file's duration where available — Aniskip matches submissions by
 * how close this is to what was submitted with them, so a wildly wrong
 * value (or none) can turn a real match into "not found."
 */
export async function aniskipTimes(
  malId: number,
  episode: number,
  episodeLengthSeconds: number
): Promise<SkipTimes | null> {
  try {
    const url = new URL(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}`)
    url.searchParams.append('types', 'op')
    url.searchParams.append('types', 'ed')
    if (Number.isFinite(episodeLengthSeconds) && episodeLengthSeconds > 0) {
      url.searchParams.set('episodeLength', String(Math.round(episodeLengthSeconds)))
    }
    const response = await fetchJson<AniskipResponse>(url)
    if (!response.found || !response.results?.length) return null

    const times: SkipTimes = {}
    for (const result of response.results) {
      const interval: SkipInterval = {
        start: result.interval.startTime,
        end: result.interval.endTime
      }
      if (result.skipType === 'op' || result.skipType === 'mixed-op') times.intro = interval
      if (result.skipType === 'ed' || result.skipType === 'mixed-ed') times.credits = interval
    }
    return times.intro || times.credits ? times : null
  } catch (error) {
    // A 404 ("no skip times found") is Aniskip's normal not-found response,
    // not a real failure — only log genuine errors (network failure, a 5xx,
    // a malformed response), not the routine "nothing submitted yet" case.
    if ((error as HttpError).status !== 404) logError('anime:skip-times', error)
    return null
  }
}

interface SkipTimesRequest {
  kitsuId: string
  episode: number
  episodeLengthSeconds: number
}

export function registerAniskipIpc(): void {
  handle<SkipTimesRequest, SkipTimes | null>(
    MEDIA_HUB_CHANNELS.playbackSkipTimes,
    async (_event, payload) => {
      const kitsuId = String(payload?.kitsuId || '')
      const episode = Number(payload?.episode)
      if (!kitsuId || !Number.isInteger(episode) || episode < 1) return null
      const malId = await kitsuMalId(kitsuId)
      if (!malId) return null
      return aniskipTimes(malId, episode, Number(payload?.episodeLengthSeconds))
    }
  )
}
