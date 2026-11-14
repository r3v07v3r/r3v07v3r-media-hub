// Image links that expire minutes after Kitsu hands them out
// (src/shared/media-hub/expiringImageUrl.ts), the AniList art that replaces
// them (animeArtwork.ts's artworkFromNode), normalizeKitsuAnime dropping
// them, and migration 8 clearing the ones already stored.
// Run with: npx tsx tests/expiringImageUrl.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  isExpiringImageUrl,
  lastingImageUrl,
  withoutExpiringImages
} from '../src/shared/media-hub/expiringImageUrl'
import { artworkFromNode } from '../src/main/media-hub/animeArtwork'
import { normalizeKitsuAnime } from '../src/main/media-hub/core'
import { migrate, SCHEMA_VERSION } from '../src/main/media-hub/migrations'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

// The shape Kitsu returned for Dragon Ball Super: Beerus (kitsu:50497).
const SIGNED =
  'https://kitsu-production-media.s3.us-west-002.backblazeb2.com/anime/50497/poster_image/24c59ad7.jpg' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20261018%2Fus-west-002%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261018T153345Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef'
const LASTING = 'https://media.kitsu.app/anime/poster_images/10879/large.jpg'
const ANILIST =
  'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx206814-PVVzRbf1IQpe.jpg'

console.log('isExpiringImageUrl')
check('a presigned Backblaze link expires', () => assert.equal(isExpiringImageUrl(SIGNED), true))
check('a plain Kitsu CDN link does not', () => assert.equal(isExpiringImageUrl(LASTING), false))
check('a v2 Signature + Expires pair expires', () =>
  assert.equal(
    isExpiringImageUrl('https://x.example/a.jpg?Expires=1&Signature=s&Key-Pair-Id=k'),
    true
  )
)
check('a query that only mentions a signature does not', () =>
  assert.equal(isExpiringImageUrl('https://x.example/a.jpg?Signature=s'), false)
)
check('empty and non-strings are not links', () => {
  assert.equal(isExpiringImageUrl(''), false)
  assert.equal(isExpiringImageUrl(undefined), false)
  assert.equal(isExpiringImageUrl('not a url?X-Amz-Signature=1'), false)
})

console.log('\nlastingImageUrl')
check('skips an expiring link for the next one', () =>
  assert.equal(lastingImageUrl(SIGNED, LASTING), LASTING)
)
check('blank when every candidate expires', () => assert.equal(lastingImageUrl(SIGNED, null), ''))

console.log('\nwithoutExpiringImages')
check('blanks image keys at any depth and leaves other fields', () => {
  const value = {
    id: 'kitsu:50497',
    poster: SIGNED,
    background: SIGNED,
    url: SIGNED,
    links: [{ relation: 'prequel', item: { poster: SIGNED, logo: LASTING } }]
  }
  const cleaned = withoutExpiringImages(value)
  assert.equal(cleaned.poster, '')
  assert.equal(cleaned.background, '')
  assert.equal(cleaned.url, SIGNED, 'only image keys are touched')
  assert.equal(cleaned.links[0].item.poster, '')
  assert.equal(cleaned.links[0].item.logo, LASTING)
  assert.equal(value.poster, SIGNED, 'the input is not mutated')
})
check('returns the same object when nothing expires', () => {
  const value = { poster: LASTING, videos: [{ thumbnail: LASTING }] }
  assert.equal(withoutExpiringImages(value), value)
})

console.log('\nnormalizeKitsuAnime')
check('drops Kitsu presigned art instead of storing it', () => {
  const item = normalizeKitsuAnime({
    id: '50497',
    attributes: {
      canonicalTitle: 'Dragon Ball Super: Beerus',
      posterImage: { original: SIGNED },
      coverImage: { original: SIGNED }
    }
  })
  assert.equal(item.poster, '')
  assert.equal(item.background, '')
})
check('keeps a lasting Kitsu link', () => {
  const item = normalizeKitsuAnime({
    id: '10879',
    attributes: { canonicalTitle: 'Dragon Ball Super', posterImage: { large: LASTING } }
  })
  assert.equal(item.poster, LASTING)
})

console.log('\nartworkFromNode')
check('cover and banner from an AniList node', () =>
  assert.deepEqual(
    artworkFromNode({
      coverImage: { extraLarge: ANILIST, large: 'x' },
      bannerImage: 'https://s4.anilist.co/b.jpg'
    }),
    { poster: ANILIST, background: 'https://s4.anilist.co/b.jpg' }
  )
)
check('blanks for a missing node', () =>
  assert.deepEqual(artworkFromNode(null), { poster: '', background: '' })
)

console.log('\nmigration 8: expiring-image-links')
check('clears stored presigned links and keeps everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-expiring-'))
  const sql = new DatabaseSync(path.join(dir, 'db.sqlite'))
  try {
    migrate(sql, 'p1')
    const json = (value: unknown): string => JSON.stringify(value)
    sql
      .prepare(
        `INSERT INTO catalog_index(id,kind,title,title_sort,poster,background,first_seen,updated_at)
         VALUES(?,?,?,?,?,?,0,0)`
      )
      .run('kitsu:50497', 'anime', 'Beerus', 'beerus', SIGNED, SIGNED)
    sql
      .prepare(
        `INSERT INTO catalog_index(id,kind,title,title_sort,poster,background,first_seen,updated_at)
         VALUES(?,?,?,?,?,?,0,0)`
      )
      .run('kitsu:10879', 'anime', 'Dragon Ball Super', 'dragon ball super', LASTING, '')
    sql
      .prepare(
        `INSERT INTO tracked(profile_id,content_id,type,title,poster,metadata_json,tracked_at)
         VALUES('p1','kitsu:50497','anime','Beerus',?,?,'2026-10-18')`
      )
      .run(SIGNED, json({ id: 'kitsu:50497', poster: SIGNED, background: SIGNED }))
    const putCache = sql.prepare(
      'INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,9e15,0)'
    )
    putCache.run('meta:v4:anime:kitsu:50497', json({ id: 'kitsu:50497', poster: SIGNED }))
    putCache.run('story:v2:anime:kitsu:8351', json({ links: [{ item: { poster: SIGNED } }] }))
    putCache.run(
      'catalog:v2:anime',
      json([
        { id: 'kitsu:50497', poster: SIGNED },
        { id: 'x', poster: LASTING }
      ])
    )
    putCache.run('meta:v4:anime:kitsu:10879', json({ id: 'kitsu:10879', poster: LASTING }))

    // Back to the version before this migration, then forward again.
    sql.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
    migrate(sql, 'p1')

    const index = sql.prepare('SELECT id, poster, background FROM catalog_index ORDER BY id').all()
    assert.deepEqual(
      index.map((row) => ({ ...row })),
      [
        { id: 'kitsu:10879', poster: LASTING, background: '' },
        { id: 'kitsu:50497', poster: '', background: '' }
      ]
    )
    const tracked = sql.prepare('SELECT poster, metadata_json FROM tracked').get() as Record<
      string,
      string
    >
    assert.equal(tracked.poster, '')
    assert.deepEqual(JSON.parse(tracked.metadata_json), {
      id: 'kitsu:50497',
      poster: '',
      background: ''
    })
    const keys = sql
      .prepare('SELECT cache_key FROM catalog_cache ORDER BY cache_key')
      .all()
      .map((row) => String((row as Record<string, unknown>).cache_key))
    assert.deepEqual(
      keys,
      ['catalog:v2:anime', 'meta:v4:anime:kitsu:10879'],
      'detail and story refetch'
    )
    const blob = sql
      .prepare("SELECT payload_json FROM catalog_cache WHERE cache_key='catalog:v2:anime'")
      .get() as Record<string, string>
    assert.deepEqual(JSON.parse(blob.payload_json), [
      { id: 'kitsu:50497', poster: '' },
      { id: 'x', poster: LASTING }
    ])
  } finally {
    sql.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${pass} passed`)
