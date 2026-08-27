// Trakt payload shapes.
//
// There is no Trakt account here, so the transport cannot be exercised — but
// the shapes can, and they are where the quiet damage lives. A show entry with
// no seasons means "the whole show" to Trakt, so getting that wrong marks an
// entire series watched from one episode; a season of 0 coerced to 1 files
// specials under the wrong season on somebody's real account.

import assert from 'node:assert/strict'

import {
  hasTraktContent,
  historyPayload,
  isTraktPushable,
  ratingsPayload,
  scrobblePayload,
  traktIds
} from '../src/main/media-hub/trakt'

const movie = { id: 'tt1160419', type: 'movie' as const, title: 'Dune' }
const show = { id: 'tt11280740', type: 'series' as const, title: 'Severance' }
const anime = { id: 'kitsu:12345', type: 'anime' as const, title: 'Frieren' }

// ---------------------------------------------------------------------
// What Trakt can be told about at all.
// ---------------------------------------------------------------------
assert.deepEqual(traktIds(movie), { imdb: 'tt1160419' })
assert.equal(traktIds(anime), null, 'a Kitsu id is not something Trakt knows')
assert.equal(traktIds({ id: '', type: 'movie', title: '' }), null)

assert.equal(isTraktPushable(movie), true)
assert.equal(isTraktPushable(show), true)
assert.equal(isTraktPushable(anime), false)

// ---------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------
assert.deepEqual(historyPayload(movie), { movies: [{ ids: { imdb: 'tt1160419' } }] })

// A timestamp only appears when one was given — Trakt defaults to "now",
// which is the right answer for a title just finished.
assert.deepEqual(historyPayload(movie, {}, '2026-01-02T03:04:05Z'), {
  movies: [{ ids: { imdb: 'tt1160419' }, watched_at: '2026-01-02T03:04:05Z' }]
})

// An episode is a SHOW carrying exactly the one season and episode. Trakt
// reads a show entry with no seasons as the ENTIRE show, so this is the
// difference between marking one episode and marking everything.
{
  const payload = historyPayload(show, { season: 2, episode: 7 })
  assert.deepEqual(payload, {
    shows: [{ ids: { imdb: 'tt11280740' }, seasons: [{ number: 2, episodes: [{ number: 7 }] }] }]
  })
  assert.ok(payload.shows?.[0].seasons?.length, 'never a bare show entry')
}

// Season 0 is the specials convention and must survive. `|| 1` would file
// somebody's specials under season one on their real account.
assert.equal(historyPayload(show, { season: 0, episode: 3 }).shows?.[0].seasons?.[0].number, 0)

// Missing coordinates fall back to the first episode rather than to a bare
// show entry, which would mean "all of it".
assert.deepEqual(historyPayload(show).shows?.[0].seasons, [
  { number: 1, episodes: [{ number: 1 }] }
])

// Anime produces nothing at all, and the emptiness is detectable.
assert.deepEqual(historyPayload(anime, { season: 1, episode: 1 }), {})
assert.equal(hasTraktContent(historyPayload(anime)), false)
assert.equal(hasTraktContent(historyPayload(movie)), true)

// ---------------------------------------------------------------------
// Ratings.
// ---------------------------------------------------------------------
assert.deepEqual(ratingsPayload(movie, 9), { movies: [{ ids: { imdb: 'tt1160419' }, rating: 9 }] })
assert.deepEqual(ratingsPayload(show, 7), { shows: [{ ids: { imdb: 'tt11280740' }, rating: 7 }] })

// A series is rated as a TITLE, not as an episode — this app's own rating is
// per title, and inventing an episode-level one would report something nobody
// said.
assert.equal(ratingsPayload(show, 7).shows?.[0].seasons, undefined)

// Out of range is refused rather than clamped: 0 is this app's "clear the
// rating" signal, and sending it as a 1 would be recording an opinion the
// person just withdrew.
assert.deepEqual(ratingsPayload(movie, 0), {})
assert.deepEqual(ratingsPayload(movie, 11), {})
assert.deepEqual(ratingsPayload(movie, Number.NaN), {})
assert.deepEqual(ratingsPayload(anime, 8), {})

// ---------------------------------------------------------------------
// Scrobbling.
// ---------------------------------------------------------------------
assert.deepEqual(scrobblePayload(movie, {}, 42), {
  progress: 42,
  movie: { ids: { imdb: 'tt1160419' } }
})
assert.deepEqual(scrobblePayload(show, { season: 1, episode: 4 }, 10), {
  progress: 10,
  show: { ids: { imdb: 'tt11280740' } },
  episode: { season: 1, number: 4 }
})

// Progress is clamped, because Trakt reads it as meaningful: a stop above its
// completion threshold is a watch and below it is a partial, so a figure
// outside 0-100 would be silently interpreted as one or the other.
assert.equal(scrobblePayload(movie, {}, 400)?.progress, 100)
assert.equal(scrobblePayload(movie, {}, -5)?.progress, 0)
assert.equal(scrobblePayload(movie, {}, Number.NaN)?.progress, 0)

// Nothing to scrobble is null rather than an empty object — the caller skips
// the request entirely rather than sending a body Trakt would reject.
assert.equal(scrobblePayload(anime, { season: 1, episode: 1 }, 50), null)

console.log('trakt payload tests passed')
