// The CSV parser and IMDb ratings reader (shared/media-hub/importCsv.ts).
//
// The parser is what stands between "The Good, the Bad and the Ugly" and a
// row silently split into three fields by a naive comma-split reader — so
// this pins down quoting, embedded commas, embedded newlines, and escaped
// quotes explicitly, not just the happy path of one clean row.

import assert from 'node:assert/strict'

import { parseCsv, parseImdbRatingsCsv } from '../src/shared/media-hub/importCsv'

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
