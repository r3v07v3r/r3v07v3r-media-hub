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
  simkl?: number
  kitsu?: number
  mal?: number
  anilist?: number
  anidb?: number
}

/**
 * Derives Simkl's `ids` object from our internal catalog id string.
 * `tt1234567` (Cinemeta/IMDb) maps straight to `{imdb}`; everything else
 * uses this app's `${provider}:${id}` convention (kitsu/mal/anilist/anidb).
 * `simkl:<n>` is Simkl's own numbering — the id normalizeSimklCatalog mints
 * when a Simkl list or search result arrives without an IMDb id — and goes
 * out as `{simkl}`, which Simkl matches exactly. Unrecognized ids resolve
 * to `{}` — Simkl treats an empty ids object as "match by title/year"
 * fallback rather than an error.
 */
export function idsForCatalogId(id: string): SimklMediaIds {
  if (/^tt\d+$/i.test(id)) return { imdb: id }
  for (const key of ['simkl', 'kitsu', 'mal', 'anilist', 'anidb'] as const) {
    if (id.startsWith(`${key}:`)) {
      const value = Number(id.split(':')[1])
      // A bare prefix (`simkl:`, from a list item with no number at all)
      // is not an id, and `{simkl: 0}` would be a real payload for nothing.
      if (Number.isInteger(value) && value > 0) return { [key]: value } as SimklMediaIds
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

// --- anime: one show here, an entry per season at Simkl ---------------------
//
// This app merges a franchise's seasons into one show: history is keyed on
// the canonical Kitsu id, and the season is the member's place in the group
// (see animeSeasons.ts's animeGroupIndexesOf). Simkl keeps an entry per
// season, each numbered from 1, and its anime ids — Kitsu's among them —
// name one of those entries. So "season 2 episode 5" here is "episode 5" of
// a different entry there, and saying it as the canonical id with a season
// number files it under the first season's entry or under nothing.
//
// The two functions below are that translation, one for each direction,
// and they are each other's inverse (tests/simklAnime.test.ts runs them
// round trip). Every Simkl anime body goes out through the first (simkl.ts),
// and the catch-up that reads Simkl back in (simklCatchUpRules.ts) lands
// where the second says. Pure, with the franchise lookup handed in:
// animeSeasons.ts owns the index and reaches a database to build it.

/**
 * The later seasons an id FRONTS, in season order (the first is season 2),
 * or nothing for an id that fronts no group — a title that was never
 * merged, and equally a merged franchise's later season asked about by its
 * own id. animeSeasons.ts's groupedIdsFor.
 *
 * A place holds null where the member there cannot be shown to be that
 * season of the show's page (see animeSeasonMatchesPage): nothing is sent
 * for such a season, rather than sent to an entry that may be another one.
 */
export type AnimeSiblings = (id: string) => readonly (string | null)[] | undefined

/**
 * What is known of a Kitsu id's place in TheTVDB: the series and season it
 * maps to, 'none' when Kitsu was asked and maps it to nothing, or null when
 * nobody has asked yet.
 */
export type AnimeTvdbSeason = (id: string) => { seriesId: string; season: number } | 'none' | null

/**
 * Whether a member's place in its group is also the season the show's PAGE
 * gives it. "Season = the member's position" is only half the story, and
 * everything that turns a member into a season of the show, or a season of
 * the show into a member, has to ask this first.
 *
 * The page numbers a merged show in one of two ways (animeSeasons.ts's
 * buildGroupedAnimeVideos). A show whose first member has no TheTVDB
 * mapping is built from its members in order, so season N IS member N. A
 * show whose first member has one is numbered by TMDB: season N is TMDB's
 * season N, whichever member happens to sit at N. The two agree only for a
 * member whose own TheTVDB season is its position. Where a film or an OVA
 * sits among the seasons, or a later season has no mapping (My Hero
 * Academia's fourth season is the group's seventh member), they do not —
 * and acting on the position would mark, open or send the wrong season.
 *
 * Unknown is no: a mapping nobody has looked up proves nothing.
 */
export function animeSeasonMatchesPage(
  showId: string,
  memberId: string,
  season: number,
  tvdbOf: AnimeTvdbSeason
): boolean {
  const show = tvdbOf(showId)
  if (show === null) return false
  if (show === 'none') return true
  const member = tvdbOf(memberId)
  if (member === null || member === 'none') return false
  return member.seriesId === show.seriesId && member.season === season
}

/** Where a raw anime id belongs: the show its history is kept under, and
 *  its season there. animeSeasons.ts's resolveAnimeGroupTarget. */
export type AnimeGroupTarget = (id: string) => { id: string; season: number }

/** One episode as this app's history holds it. */
export interface LocalAnimeEpisode {
  id: string
  season: number
  episode: number
}

/** One episode as Simkl holds it: the entry's own id, and the episode's
 *  number within that entry. No season — an entry has only the one. */
export interface SimklAnimeEpisode {
  id: string
  episode: number
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * Where an episode held here lives at Simkl, or null when it has no place
 * there and nothing may be sent.
 *
 *  - Season 1 is the id's own entry, always: the canonical id's first
 *    season, a title that was never merged, a later season opened by its
 *    own id.
 *  - A later season of an id that fronts a group is that season's member.
 *    One the group has no member for is not sent.
 *  - A later season of an id that fronts NO group is still that id's own
 *    entry. Its episode list is Kitsu's for the one entry, and the season
 *    on it is only Kitsu's label; the episode number is already the
 *    entry's own.
 *  - Season 0 is the specials TMDB lists for the whole franchise. They are
 *    episodes of no Simkl entry this app can name, so they are not sent.
 *
 * `siblingsOf` is left out while the catalog has not been grouped (see
 * animeSeasons.ts's animeGroupingReady). Until then nothing can tell a
 * merged show from an unmerged one, so only a first season is placed:
 * sending a later one to the id it was asked under is exactly the misfiling
 * this exists to stop.
 */
export function toSimklAnimeEpisode(
  local: { id: string; season?: number | null; episode?: number | null },
  siblingsOf: AnimeSiblings | undefined
): SimklAnimeEpisode | null {
  const { id, episode } = local
  const season = local.season ?? 1
  if (!isCount(episode) || !isCount(season)) return null
  if (season === 1) return { id, episode }
  if (!siblingsOf) return null
  const siblings = siblingsOf(id)
  if (!siblings?.length) return { id, episode }
  const member = siblings[season - 2]
  return member ? { id: String(member), episode } : null
}

/**
 * The inverse: where an episode of a Simkl anime entry is kept here — under
 * the show the entry's Kitsu id belongs to, at the season it is there.
 *
 * Exact for everything toSimklAnimeEpisode sends on behalf of a show's own
 * id. Two things it deliberately does not hand back as they went out,
 * because the entry is all Simkl remembers: a later season written under
 * its own id comes back under the show it belongs to, and a title that
 * fronts no group comes back at season 1 whatever season Kitsu labelled it.
 */
export function fromSimklAnimeEpisode(
  remote: SimklAnimeEpisode,
  targetOf: AnimeGroupTarget
): LocalAnimeEpisode | null {
  if (!isCount(remote.episode)) return null
  const target = targetOf(remote.id)
  if (!isCount(target.season)) return null
  return { id: target.id, season: target.season, episode: remote.episode }
}

/**
 * The show a later season belongs to, when `id` names a later season of a
 * merged franchise by its own id — or null, for a show's own id and for a
 * title that was never merged.
 *
 * A later season still has an id of its own: it is what a service lists it
 * under, and so what a watchlist pull plans it under. Opened or written by
 * that id it must not become a second copy of the show's season, which is
 * what this is asked for.
 */
export function animeSeasonOf(
  id: string,
  targetOf: AnimeGroupTarget
): { id: string; season: number } | null {
  const target = targetOf(id)
  return target.id === id ? null : target
}

/**
 * Where an episode named under `id` is KEPT here: for a later season named
 * by its own id, under its show at the season it is there; for anything
 * else, where it was named.
 *
 * The season such an id arrives with is not carried over. It is Kitsu's
 * label inside that one entry (often the same number, not always), and the
 * episode number is already the entry's own — the same numbering the show's
 * episode list gives that season, and the one fromSimklAnimeEpisode files a
 * Simkl entry by. A row with no episode is left alone: it is not an
 * episode of anything.
 */
export function animeHistoryCoordinates<
  T extends { id: string; season?: number | null; episode?: number | null }
>(local: T, targetOf: AnimeGroupTarget): T {
  if (local.episode == null) return local
  const show = animeSeasonOf(local.id, targetOf)
  return show ? { ...local, id: show.id, season: show.season } : local
}
