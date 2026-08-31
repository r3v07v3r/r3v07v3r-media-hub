// Ingest validation for household title sync (shared/lancache/titleSync).
// The trust rule under test: a paired daemon is trusted to serve media,
// NOT to inject rows into a database the renderer reads ids and URLs
// from — so every row is validated at the client, individually.
// Run with: npx tsx tests/lanCacheTitleSync.test.ts

import assert from 'node:assert/strict'

import {
  sanitizeDaemonTitleRow,
  TITLE_SYNC_MAX_PAGES_PER_PASS,
  TITLE_SYNC_PAGE_LIMIT
} from '../src/shared/lancache/titleSync'

let pass = 0
const failures: string[] = []
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass += 1
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`)
  }
}

function wireRow(over: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}) {
  return {
    seq: 7,
    kind: 'movie',
    rank: 1200,
    item: {
      id: 'tt1234',
      title: 'A Film',
      type: 'movie',
      poster: 'https://img.example/p.jpg',
      background: 'https://img.example/b.jpg',
      logo: '',
      year: '2020',
      status: '',
      description: 'Fine.',
      rating: '7.1',
      runtime: '110 min',
      genres: ['Drama', 'Crime'],
      ...itemOver
    },
    // Envelope overrides come LAST so `item: null` really is null.
    ...over
  }
}

check('a well-formed row passes, with exactly the index fields', () => {
  const row = sanitizeDaemonTitleRow(wireRow())
  assert.ok(row)
  assert.equal(row.seq, 7)
  assert.equal(row.kind, 'movie')
  assert.equal(row.rank, 1200)
  assert.equal(row.item.id, 'tt1234')
  assert.equal(row.item.title, 'A Film')
  assert.deepEqual(row.item.genres, ['Drama', 'Crime'])
  assert.deepEqual(row.item.videos, [], 'no per-episode data rides in')
  assert.deepEqual(row.item.trailers, [])
})

check('the id alphabet is closed: tt and kitsu ids only, exactly', () => {
  const good = ['tt1', 'tt1234567', 'kitsu:1', 'kitsu:99999']
  for (const id of good) {
    assert.ok(sanitizeDaemonTitleRow(wireRow({}, { id })), `${id} is a real id`)
  }
  const bad = [
    'tt1 OR 1=1',
    'javascript:alert(1)',
    'kitsu:abc',
    'tmdb:123',
    'tt',
    ' tt1',
    'tt1\n',
    '../etc/passwd',
    ''
  ]
  for (const id of bad) {
    assert.equal(sanitizeDaemonTitleRow(wireRow({}, { id })), null, `${JSON.stringify(id)} is not`)
  }
})

check('artwork is https or absent — never http, never another scheme', () => {
  assert.ok(sanitizeDaemonTitleRow(wireRow({}, { poster: '' })), 'absent artwork is fine')
  for (const field of ['poster', 'background', 'logo']) {
    for (const url of [
      'http://img.example/p.jpg',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'chrome://settings',
      '//img.example/p.jpg'
    ]) {
      assert.equal(
        sanitizeDaemonTitleRow(wireRow({}, { [field]: url })),
        null,
        `${field}=${url} must reject the ROW — a laundered URL is worse than a lost row`
      )
    }
  }
})

check('a row is rejected whole on a bad envelope, not patched up', () => {
  assert.equal(sanitizeDaemonTitleRow(null), null)
  assert.equal(sanitizeDaemonTitleRow('tt1'), null)
  assert.equal(sanitizeDaemonTitleRow(wireRow({ seq: 0 })), null, 'seq must be positive')
  assert.equal(sanitizeDaemonTitleRow(wireRow({ seq: 'x' })), null)
  assert.equal(sanitizeDaemonTitleRow(wireRow({ rank: -1 })), null)
  assert.equal(sanitizeDaemonTitleRow(wireRow({ kind: 'games' })), null)
  assert.equal(sanitizeDaemonTitleRow(wireRow({ item: null })), null)
  assert.equal(sanitizeDaemonTitleRow(wireRow({}, { title: '' })), null, 'a title is required')
})

check('text is capped and unknown fields do not pass through', () => {
  const row = sanitizeDaemonTitleRow(
    wireRow(
      {},
      {
        description: 'x'.repeat(10_000),
        genres: Array.from({ length: 50 }, (_, i) => `g${i}`),
        evil: 'payload',
        videos: [{ id: 'smuggled' }]
      }
    )
  )
  assert.ok(row)
  assert.equal(row.item.description.length, 4000)
  assert.equal(row.item.genres.length, 20)
  assert.ok(!('evil' in row.item), 'a field this version cannot name cannot reach the database')
  assert.deepEqual(row.item.videos, [], 'daemon-supplied videos are dropped, not stored')
})

check('the kind decides the stored type — a lying item.type does not', () => {
  const row = sanitizeDaemonTitleRow(wireRow({ kind: 'series' }, { type: 'movie' }))
  assert.ok(row)
  assert.equal(row.item.type, 'series', 'type follows the validated kind envelope')
})

check('pass bounds are sane: a full pass is bounded but not tiny', () => {
  assert.ok(TITLE_SYNC_PAGE_LIMIT >= 100 && TITLE_SYNC_PAGE_LIMIT <= 1000)
  assert.ok(TITLE_SYNC_MAX_PAGES_PER_PASS >= 10)
})

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(`\n${pass} passed`)
if (failures.length) process.exit(1)
