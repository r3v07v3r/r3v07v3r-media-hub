// Which service a rating came from.
//
// Its own module rather than living beside the badge that draws it,
// because a file that exports both components and plain functions loses
// fast refresh (react-refresh/only-export-components) — and this is
// imported by card meta rows that are edited constantly.

export type RatingSource = 'imdb' | 'kitsu' | 'rottenTomatoes'

export const RATING_SOURCE_LABELS: Record<RatingSource, string> = {
  imdb: 'IMDb',
  kitsu: 'Kitsu',
  rottenTomatoes: 'Rotten Tomatoes'
}

/**
 * Which service the single `rating` figure came from, by kind.
 *
 * Movie and series ids in this catalog ARE IMDb ids and the figure comes
 * from IMDb (Cinemeta, with a Simkl fallback). Anime has no IMDb id at all
 * and its figure is Kitsu's averageRating — so labelling it IMDb would be a
 * plain misattribution, which is why this is a function and not a constant.
 */
export function ratingSourceFor(kind: 'movie' | 'series' | 'anime' | undefined): RatingSource {
  return kind === 'anime' ? 'kitsu' : 'imdb'
}
