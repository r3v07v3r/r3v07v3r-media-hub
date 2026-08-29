// Where a title can be streamed, rented or bought, in the person's own region.
//
// The one gap in the original analysis that nobody expects a media app to
// have. Stremio, Simkl, Trakt, JustWatch and Reelgood all answer it, and it is
// the question somebody asks about a film they cannot get any other way.
//
// TMDB carries JustWatch's data and asks that it be attributed as such, which
// is why the panel says so. It is keyed by REGION and there is no sensible
// global answer — availability is exactly the thing that differs by country —
// so a region that has never been set falls back to the machine's own locale
// rather than to a hardcoded US.

import type { MediaKind, WatchProvider, WatchProvidersResult } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import { readSettings, tmdbCredentials } from './settingsStore'

/**
 * Electron, resolved at CALL time rather than imported at load time — the
 * same pattern settingsStore.ts and logger.ts carry, for the same reason.
 * `require('electron')` throws when the binary is absent, which is exactly
 * what CI's `npm ci --ignore-scripts` produces, and this module is reached
 * from preferences.ts, whose pure resolution logic is unit tested outside
 * Electron. The one use below runs only in the real app.
 */
function electron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

const EMPTY: Omit<WatchProvidersResult, 'region'> = { stream: [], rent: [], buy: [], link: '' }

/** A day. Availability moves — titles leave one service for another — but not
 *  within an evening, and this is on the path of opening a title page. */
const TTL_MS = 24 * 60 * 60 * 1000

/**
 * The region to answer for.
 *
 * A stored setting wins. Failing that, the second half of the machine's own
 * locale ("en-GB" -> "GB") is a far better guess than any fixed default: it is
 * usually right, and when it is wrong it is wrong in a way somebody can see
 * and correct in Settings.
 */
export function watchRegion(): string {
  const stored = String(readSettings().watchRegion || '')
    .trim()
    .toUpperCase()
  if (/^[A-Z]{2}$/.test(stored)) return stored
  const locale = electron().app?.getLocale?.() ?? ''
  const guess = locale.split(/[-_]/)[1]?.toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(guess) ? guess : 'US'
}

interface RawProvider {
  provider_id?: unknown
  provider_name?: unknown
  logo_path?: unknown
}

interface RawRegion {
  link?: unknown
  flatrate?: RawProvider[]
  free?: RawProvider[]
  ads?: RawProvider[]
  rent?: RawProvider[]
  buy?: RawProvider[]
}

function normalize(list: RawProvider[] | undefined): WatchProvider[] {
  const seen = new Set<number>()
  const out: WatchProvider[] = []
  for (const raw of list ?? []) {
    const id = Number(raw?.provider_id)
    const name = String(raw?.provider_name ?? '').trim()
    if (!Number.isFinite(id) || !name || seen.has(id)) continue
    seen.add(id)
    const logoPath = String(raw?.logo_path ?? '')
    out.push({
      id,
      name,
      logo: logoPath ? `https://image.tmdb.org/t/p/w92${logoPath}` : ''
    })
  }
  return out
}

/**
 * Where `imdbId` can be watched.
 *
 * Anime is not supported and returns nothing: the catalog gives it a Kitsu id,
 * TMDB's lookup takes an IMDb one, and guessing at a match by title is how a
 * page ends up confidently listing the streaming services for a different
 * show. The same reason the Sonarr/Radarr request panel skips it.
 */
export async function watchProviders(
  kind: MediaKind,
  imdbId: string
): Promise<WatchProvidersResult> {
  const region = watchRegion()
  if (kind === 'anime' || !/^tt\d+$/.test(imdbId)) return { region, ...EMPTY }

  const { apiKey } = tmdbCredentials()
  if (!apiKey) return { region, ...EMPTY }

  const db = getDatabase()
  // Region is part of the key, so switching country does not serve back the
  // previous one's answer.
  const cacheKey = `providers:v1:${kind}:${imdbId}:${region}`
  const cached = db.getCache<WatchProvidersResult>(cacheKey)
  if (cached) return cached

  const auth = `api_key=${encodeURIComponent(apiKey)}`
  const path = kind === 'series' ? 'tv' : 'movie'
  try {
    const found = await fetchJson<{
      movie_results?: { id?: unknown }[]
      tv_results?: { id?: unknown }[]
    }>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?${auth}&external_source=imdb_id`
    )
    const results = kind === 'series' ? found.tv_results : found.movie_results
    const tmdbId = Number(results?.[0]?.id)
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      // Cached as empty on purpose. A title TMDB has never heard of will still
      // not be there tomorrow, and re-asking on every page open would be a
      // request per visit for a permanent no.
      const miss = { region, ...EMPTY }
      db.putCache(cacheKey, miss, TTL_MS)
      return miss
    }

    const payload = await fetchJson<{ results?: Record<string, RawRegion> }>(
      `https://api.themoviedb.org/3/${path}/${tmdbId}/watch/providers?${auth}`
    )
    const forRegion = payload.results?.[region]
    const result: WatchProvidersResult = {
      region,
      // free and ad-supported tiers are folded in with subscriptions: the
      // distinction that matters to somebody deciding what to do tonight is
      // "can I just watch it" versus "do I have to pay for it", and all three
      // are on the right side of that line.
      stream: normalize([
        ...(forRegion?.flatrate ?? []),
        ...(forRegion?.free ?? []),
        ...(forRegion?.ads ?? [])
      ]),
      rent: normalize(forRegion?.rent),
      buy: normalize(forRegion?.buy),
      link: String(forRegion?.link ?? '')
    }
    db.putCache(cacheKey, result, TTL_MS)
    return result
  } catch {
    // Not cached: unlike a TMDB miss, a failure here is usually the network,
    // and a temporary outage should not be remembered for a day.
    return { region, ...EMPTY }
  }
}
