// Optional OMDb integration (https://www.omdbapi.com) — the only one of
// this app's existing metadata sources (Cinemeta, Kitsu, Simkl, TMDB) that
// carries Rotten Tomatoes scores at all; none of the others expose RT data
// in their own APIs. Wired the same way TMDB is (see catalog.ts's
// tmdbConnect/tmdbDisconnect handlers): a user-supplied API key, verified
// against the live API before being encrypted and persisted, exposed to
// the renderer as a plain connected/disconnected boolean.

import type { ConnectResult } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { encrypt, omdbCredentials, readSettings, writeSettings } from './settingsStore'

interface OmdbRatingEntry {
  Source?: string
  Value?: string
}

/**
 * Cached (24h) Rotten Tomatoes critic score for one IMDb id, via OMDb.
 * Returns undefined — never throws — whenever OMDb isn't connected, `id`
 * isn't a real `tt\d+` IMDb id (anime ids are `kitsu:...`, unresolved Simkl
 * ids are `simkl:...` — see catalog.ts's metadata(), which only calls this
 * for movie/series after resolving to a real IMDb id), OMDb has no Rotten
 * Tomatoes entry for this title, or the request fails for any reason.
 * Callers treat all of those identically to "OMDb isn't connected" — this
 * is an enrichment, never a hard requirement for the detail page to load.
 *
 * The empty string is cached (not `undefined`/`null`) for "confirmed no
 * Rotten Tomatoes entry" — getCache<T> returns `null` for a cache MISS
 * too, so a bare `null` can't also mean "cached, and the answer is none"
 * without every miss being re-fetched forever (same sentinel reasoning as
 * animeSeasons.ts's NO_TVDB_MAPPING). A real score is never an empty
 * string, so this is an unambiguous sentinel.
 */
export async function omdbRottenTomatoesRating(imdbId: string): Promise<string | undefined> {
  const { apiKey } = omdbCredentials()
  if (!apiKey || !/^tt\d+$/.test(imdbId)) return undefined

  const key = `omdb:rt:${imdbId}`
  const db = getDatabase()
  const cached = db.getCache<string>(key)
  if (cached !== null) return cached || undefined

  try {
    const result = await fetchJson<{ Ratings?: OmdbRatingEntry[] }>(
      `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`,
      {},
      // A Rotten Tomatoes score is garnish on a detail page that has
      // already rendered without it. It should never be ahead of anything
      // in the queue.
      { priority: 'background', label: 'Rotten Tomatoes score' }
    )
    const entry = (result.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes')
    const value = entry?.Value?.match(/\d+/)?.[0] || ''
    db.putCache(key, value, 24 * 60 * 60 * 1000)
    return value || undefined
  } catch (error) {
    logError('omdb:rating', error)
    return undefined
  }
}

export function registerOmdbIpc(): void {
  handle<string, ConnectResult>(MEDIA_HUB_CHANNELS.omdbConnect, async (_e, raw) => {
    const value = String(raw || '').trim()
    if (!value) return { ok: false, message: 'Enter an OMDb API key.' }
    try {
      // tt0111161 (The Shawshank Redemption) — a permanently-stable id used
      // purely to verify the key against the live API, same round-trip
      // check tmdbConnect does against TMDB's own /authentication endpoint.
      // OMDb has no dedicated key-check endpoint of its own.
      const result = await fetchJson<{ Response?: string }>(
        `https://www.omdbapi.com/?i=tt0111161&apikey=${encodeURIComponent(value)}`
      )
      if (result.Response !== 'True') {
        return { ok: false, message: 'That OMDb API key was rejected.' }
      }
      const s = readSettings()
      s.omdbApiKey = encrypt(value)
      writeSettings(s)
      return { ok: true, message: 'OMDb connected.' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  handle<undefined, ConnectResult>(MEDIA_HUB_CHANNELS.omdbDisconnect, () => {
    const s = readSettings()
    delete s.omdbApiKey
    writeSettings(s)
    return { ok: true }
  })
}
