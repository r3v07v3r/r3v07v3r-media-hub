// Which catalog ids are REAL — expressible to a tracking service — and
// which only exist inside this app.
//
// This lived in src/main/media-hub/simkl.ts (it is still re-exported from
// there, unchanged, for everything main-side that already imports it). It
// moved to shared when demo ids leaked into real user data: three
// watch_history rows with mockData ids (m-10/m-11/m-13 — Interstellar,
// The Martian, Ex Machina) were written on 2026-08-24 through the
// demo-pool fallback, duplicating films already tracked under their real
// IMDb ids, and both the renderer and the migration that cleans up those
// rows needed the same predicate.
//
// The predicate has since been narrowed back to what its name says. It
// briefly also served as a library-WRITE guard — refuse the add, tell the
// person "this is a demo title from the built-in sample catalog" — which
// only held while the demo pool was the sole producer of an inexpressible
// id. The pool is gone (see renderer/src/data/constants.ts), and the
// guard's remaining catch was real titles: a tracked show with a good
// IMDb id, reached through a surface that handed over an episode-shaped
// or not-yet-bridged id, was told it was demo data. Nothing writes on
// this answer any more. It decides what can be PUSHED, and a title that
// can't be pushed is still perfectly real and still belongs in the local
// library.
//
// Simkl's id space is deliberately the one tested: it is the UNION of what
// every connected service can address (IMDb for movies/series — which is
// also all Trakt is ever sent — plus kitsu/mal/anilist/anidb for anime,
// which is what the MAL push resolves through). An id no Simkl payload can
// carry is an id NO service can be told about, so "expressible to Simkl"
// and "expressible to any service" are the same predicate today; if a
// service with a broader id space is ever added, this file is the one
// place that assumption lives.

/** At most one id is ever populated, keyed by which service the catalog id encodes. */
export interface SimklMediaIds {
  imdb?: string
  kitsu?: number
  mal?: number
  anilist?: number
  anidb?: number
}

/**
 * Derives Simkl's `ids` object from our internal catalog id string.
 * `tt1234567` (Cinemeta/IMDb) maps straight to `{imdb}`; everything else
 * uses this app's `${provider}:${id}` convention (kitsu/mal/anilist/anidb).
 * Unrecognized ids resolve to `{}` — Simkl treats an empty ids object as
 * "match by title/year" fallback rather than an error.
 */
export function idsForCatalogId(id: string): SimklMediaIds {
  if (/^tt\d+$/i.test(id)) return { imdb: id }
  for (const key of ['kitsu', 'mal', 'anilist', 'anidb'] as const) {
    if (id.startsWith(`${key}:`)) {
      const value = Number(id.split(':')[1])
      if (Number.isFinite(value)) return { [key]: value } as SimklMediaIds
    }
  }
  return {}
}

/**
 * Whether a catalog id can be expressed to Simkl as a REAL id — the
 * precondition for a push whose outcome can be verified, and for a diff
 * that can ever see the result. An id that resolves to `{}` goes out as a
 * title/year guess: Simkl either matches it against an entry the diff will
 * never join back to this id, or rejects it in a not_found entry that
 * carries no ids and so can't be attributed to anything (see
 * unmatchedCatalogIds). Either way the local record stays where it was and
 * the disagreement resurfaces on the next check, forever.
 */
export function hasExpressibleSimklId(id: string): boolean {
  return Object.keys(idsForCatalogId(id)).length > 0
}
