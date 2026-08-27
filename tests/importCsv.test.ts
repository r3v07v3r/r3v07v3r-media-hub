// The CSV parser and IMDb ratings reader (shared/media-hub/importCsv.ts).
//
// The parser is what stands between "The Good, the Bad and the Ugly" and a
// row silently split into three fields by a naive comma-split reader — so
// this pins down quoting, embedded commas, embedded newlines, and escaped
// quotes explicitly, not just the happy path of one clean row.

import assert from 'node:assert/strict'

import {
  matchLetterboxdCandidate,
  parseCsv,
  parseImdbRatingsCsv,
  parseLetterboxdDiaryCsv,
  parseLetterboxdRatingsCsv
} from '../src/shared/media-hub/importCsv'

// ---------------------------------------------------------------------
// The parser itself.
// ---------------------------------------------------------------------
assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [
  ['a', 'b', 'c'],
  ['1', '2', '3']
])

// A comma inside quotes is data, not a field boundary — the whole reason
// this exists rather than String.split(',').
assert.deepEqual(parseCsv('Title,Year\n"The Good, the Bad and the Ugly",1966'), [
  ['Title', 'Year'],
  ['The Good, the Bad and the Ugly', '1966']
])

// A doubled quote inside a quoted field is one literal quote character.
assert.deepEqual(parseCsv('Title\n"He said ""hello"""'), [['Title'], ['He said "hello"']])

// A newline inside quotes is part of the field, not a row boundary — real
// for a review or notes column, and the reason this cannot be a
// line-by-line reader.
assert.deepEqual(parseCsv('Notes\n"first line\nsecond line"'), [
  ['Notes'],
  ['first line\nsecond line']
])

// CRLF, which is what both IMDb and Letterboxd actually export.
assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
  ['a', 'b'],
  ['1', '2']
])

// A trailing blank line at EOF is not a phantom empty row.
assert.deepEqual(parseCsv('a,b\n1,2\n'), [
  ['a', 'b'],
  ['1', '2']
])

// ---------------------------------------------------------------------
// IMDb's ratings export.
// ---------------------------------------------------------------------
const header =
  'Const,Your Rating,Date Rated,Title,Title Type,IMDb Rating,Year,Genres,Num Votes,Directors'

{
  const csv = [
    header,
    'tt1160419,9,2024-03-15,Dune: Part Two,movie,8.5,2024,"Action, Adventure, Drama",900000,Denis Villeneuve',
    'tt11280740,8,2023-01-10,Severance,tvSeries,8.7,2022,"Drama, Mystery, Sci-Fi",200000,Ben Stiller'
  ].join('\n')
  const { rows, skipped } = parseImdbRatingsCsv(csv)
  assert.equal(skipped, 0)
  assert.deepEqual(rows, [
    { id: 'tt1160419', score: 9, ratedAt: '2024-03-15' },
    { id: 'tt11280740', score: 8, ratedAt: '2023-01-10' }
  ])
}

// Column order does not matter — this reads by NAME, because IMDb has
// reordered this export's columns before and a position-keyed reader would
// silently read the wrong field the next time they do it again.
{
  const reordered = [
    'Your Rating,Const,Title,Date Rated',
    '7,tt0110912,Pulp Fiction,2020-06-01'
  ].join('\n')
  assert.deepEqual(parseImdbRatingsCsv(reordered).rows, [
    { id: 'tt0110912', score: 7, ratedAt: '2020-06-01' }
  ])
}

// Rows this app cannot honestly use are skipped and counted, never guessed
// at: no IMDb id, an out-of-range rating, a date that does not parse.
{
  const csv = [
    header,
    // No IMDb id at all.
    ',9,2024-01-01,Something,movie,7.0,2020,Drama,1000,Someone',
    // Out of this app's 1-10 range.
    'tt0000001,11,2024-01-01,Bad Rating,movie,7.0,2020,Drama,1000,Someone',
    'tt0000002,0,2024-01-01,Zero Rating,movie,7.0,2020,Drama,1000,Someone',
    // Unparseable date.
    'tt0000003,5,not-a-date,Bad Date,movie,7.0,2020,Drama,1000,Someone',
    // A genuinely good row, to prove the file as a whole still yields it.
    'tt0000004,6,2024-01-01,Good Row,movie,7.0,2020,Drama,1000,Someone'
  ].join('\n')
  const { rows, skipped } = parseImdbRatingsCsv(csv)
  assert.equal(skipped, 4)
  assert.deepEqual(rows, [{ id: 'tt0000004', score: 6, ratedAt: '2024-01-01' }])
}

console.log('import CSV tests passed')

// ---------------------------------------------------------------------
// Letterboxd — diary.csv (viewings).
// ---------------------------------------------------------------------
{
  const header = 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date'
  const csv = [
    header,
    '2024-03-16,Dune: Part Two,2024,https://boxd.it/abc,4.5,,,2024-03-15',
    // A rewatch is still its own viewing, with its own date.
    '2024-06-01,Dune: Part Two,2024,https://boxd.it/abc,,Yes,,2024-05-30'
  ].join('\n')
  const { rows, skipped } = parseLetterboxdDiaryCsv(csv)
  assert.equal(skipped, 0)
  assert.deepEqual(rows, [
    { name: 'Dune: Part Two', year: '2024', watchedAt: '2024-03-15' },
    { name: 'Dune: Part Two', year: '2024', watchedAt: '2024-05-30' }
  ])
}

// Rows with nothing usable are skipped: no title, no year, or — the case
// that matters most — no Watched Date at all. watched.csv's own Date
// column is deliberately never read as a substitute; see this module's own
// header on why that column cannot be trusted as a viewing date.
{
  const header = 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date'
  const csv = [
    header,
    '2020-01-01,,2020,https://boxd.it/x,,,,2020-01-01',
    '2020-01-01,Untitled Year,,https://boxd.it/x,,,,2020-01-01',
    '2020-01-01,Some Film,2020,https://boxd.it/x,,,,',
    '2020-01-01,Some Film,2020,https://boxd.it/x,,,,not-a-date'
  ].join('\n')
  const { rows, skipped } = parseLetterboxdDiaryCsv(csv)
  assert.equal(rows.length, 0)
  assert.equal(skipped, 4)
}

// ---------------------------------------------------------------------
// Letterboxd — ratings.csv.
// ---------------------------------------------------------------------
{
  const header = 'Date,Name,Year,Letterboxd URI,Rating'
  const csv = [
    header,
    '2023-01-10,Severance,2022,https://boxd.it/def,4.5',
    '2023-02-01,Cats,2019,https://boxd.it/ghi,0.5'
  ].join('\n')
  const { rows, skipped } = parseLetterboxdRatingsCsv(csv)
  assert.equal(skipped, 0)
  // Half-star to this app's 1-10 scale is an exact doubling: 4.5 -> 9,
  // 0.5 -> 1 — the two ends of Letterboxd's whole range.
  assert.deepEqual(rows, [
    { name: 'Severance', year: '2022', score: 9, ratedAt: '2023-01-10' },
    { name: 'Cats', year: '2019', score: 1, ratedAt: '2023-02-01' }
  ])
}

// An unrated diary/watched row never reaches ratings.csv at all — Letterboxd
// only writes an entry here when a star rating was actually given — but a
// malformed or out-of-range value is still skipped rather than clamped.
{
  const header = 'Date,Name,Year,Letterboxd URI,Rating'
  const csv = [
    header,
    '2023-01-01,No Rating,2020,https://boxd.it/x,',
    '2023-01-01,Bad Rating,2020,https://boxd.it/x,6',
    '2023-01-01,Zero Rating,2020,https://boxd.it/x,0'
  ].join('\n')
  const { rows, skipped } = parseLetterboxdRatingsCsv(csv)
  assert.equal(rows.length, 0)
  assert.equal(skipped, 3)
}

console.log('letterboxd CSV tests passed')

// ---------------------------------------------------------------------
// Letterboxd's title/year -> TMDB candidate match — the one place this
// whole import can go quietly wrong, so it gets the most scrutiny.
// ---------------------------------------------------------------------
{
  const candidate = (
    over: Partial<{ id: number; title: string; originalTitle: string; releaseYear: string }>
  ) => ({
    id: 1,
    title: 'Dune: Part Two',
    originalTitle: 'Dune: Part Two',
    releaseYear: '2024',
    ...over
  })

  // The ordinary case: one candidate, matching on both name and year.
  assert.equal(
    matchLetterboxdCandidate({ name: 'Dune: Part Two', year: '2024' }, [candidate({})]),
    1
  )

  // Case and surrounding whitespace do not matter.
  assert.equal(
    matchLetterboxdCandidate({ name: '  dune: part two  ', year: '2024' }, [candidate({})]),
    1
  )

  // A foreign-language film matched by its ORIGINAL title, not the
  // (possibly English) `title` TMDB also carries.
  assert.equal(
    matchLetterboxdCandidate(
      { name: 'Le Fabuleux Destin d\u2019Am\u00e9lie Poulain', year: '2001' },
      [
        candidate({
          title: 'Amelie',
          originalTitle: 'Le Fabuleux Destin d\u2019Am\u00e9lie Poulain',
          releaseYear: '2001'
        })
      ]
    ),
    1
  )

  // The year must match exactly — a title match alone is not enough, since
  // a remake can share a name across decades.
  assert.equal(
    matchLetterboxdCandidate({ name: 'Dune: Part Two', year: '2023' }, [candidate({})]),
    null
  )

  // Nothing at all matches.
  assert.equal(matchLetterboxdCandidate({ name: 'Not Dune', year: '2024' }, [candidate({})]), null)

  // More than one survivor is not a confident match either — a remake
  // sharing both title and year has no third signal here to break the tie
  // with, so it is left alone rather than guessed at.
  assert.equal(
    matchLetterboxdCandidate({ name: 'Dune: Part Two', year: '2024' }, [
      candidate({ id: 1 }),
      candidate({ id: 2 })
    ]),
    null
  )

  // No candidates at all.
  assert.equal(matchLetterboxdCandidate({ name: 'Dune: Part Two', year: '2024' }, []), null)
}

console.log('letterboxd matching tests passed')
