// Regression tests for three smaller 2026-11-21 security-scan fixes:
//   F32 — the ai:screenshot static server must not serve files outside its root
//   F34 — the runtime parser must do bounded work over an unbounded string
//   F35 — profiles from a restored backup are rebuilt from an allowlist
// Run with: npx tsx tests/miscHardening.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAllowedHost, isInsideRoot, resolveStaticPath } from '../scripts/ai-static-path'
import { readBackup } from '../src/main/media-hub/backup'
import {
  MAX_BACKUP_PROFILES,
  sanitizeBackupProfile,
  sanitizeBackupProfiles
} from '../src/main/media-hub/backupProfiles'
import { createDatabase } from '../src/main/media-hub/database'
import { runtimeMinutesOrZero as runtimeMinutes } from '../src/shared/media-hub/runtime'

// --- F32: static server path traversal -------------------------------------
{
  const root = path.resolve(os.tmpdir(), 'r3-static-root', 'out', 'renderer')

  assert.equal(resolveStaticPath(root, '/'), root)
  assert.equal(resolveStaticPath(root, '/index.html'), path.join(root, 'index.html'))
  assert.equal(
    resolveStaticPath(root, '/assets/app.js?v=1#x'),
    path.join(root, 'assets', 'app.js'),
    'query and fragment are ignored'
  )
  assert.equal(resolveStaticPath(root, '/a/../index.html'), path.join(root, 'index.html'))
  assert.equal(
    resolveStaticPath(root, '/..foo'),
    path.join(root, '..foo'),
    'a dotted name is not ..'
  )

  for (const attack of [
    '/../../.env.local',
    '/..%2f..%2f.env.local',
    '/%2e%2e/%2e%2e/.env.local',
    '/..\\..\\.env.local',
    '/..%5c..%5c.env.local',
    '/assets/../../secret',
    '/..',
    '../outside',
    '/%2e%2e'
  ]) {
    assert.equal(resolveStaticPath(root, attack), null, `traversal refused: ${attack}`)
  }
  assert.equal(
    resolveStaticPath(root, '/%E0%A4%A'),
    null,
    'malformed encoding is refused, not thrown'
  )
  assert.equal(resolveStaticPath(root, '/index.html%00.png'), null, 'NUL byte refused')
  if (process.platform === 'win32') {
    assert.equal(resolveStaticPath(root, '/C:/Windows/win.ini'), null, 'drive letter cannot escape')
    assert.equal(resolveStaticPath(root, '/C%3A%5CWindows%5Cwin.ini'), null)
  }
  assert.equal(resolveStaticPath(root, '//etc/passwd'), path.join(root, 'etc', 'passwd'))

  assert.equal(isInsideRoot(root, root), true)
  assert.equal(isInsideRoot(root, path.dirname(root)), false)
  assert.equal(isInsideRoot(root, root + 'x'), false, 'a sibling sharing the prefix is outside')

  assert.equal(isAllowedHost('127.0.0.1:4321', 4321), true)
  assert.equal(isAllowedHost('localhost:4321', 4321), true)
  assert.equal(isAllowedHost('evil.example:4321', 4321), false, 'DNS-rebinding host refused')
  assert.equal(isAllowedHost('127.0.0.1:1', 4321), false)
  assert.equal(isAllowedHost(undefined, 4321), false)
}

// --- F34: runtimeMinutes is linear and bounded -----------------------------
{
  assert.equal(runtimeMinutes('48 min'), 48)
  assert.equal(runtimeMinutes('2h 15m'), 135)
  assert.equal(runtimeMinutes('1 h 30'), 90)
  assert.equal(runtimeMinutes('2h'), 120)
  assert.equal(runtimeMinutes('148'), 148)
  assert.equal(runtimeMinutes(148), 148)
  assert.equal(runtimeMinutes('2H 5M'), 125)
  assert.equal(runtimeMinutes(''), 0)
  assert.equal(runtimeMinutes(null), 0)
  assert.equal(runtimeMinutes('unknown'), 0)

  // The crafted backup row: a few hundred thousand digits with no 'h'. The old
  // unanchored /(\d+)\s*h/ backtracked O(n^2) on this.
  for (const hostile of [
    '1'.repeat(300_000),
    '1'.repeat(300_000) + 'x',
    ' '.repeat(300_000) + '1h'
  ]) {
    const started = process.hrtime.bigint()
    const minutes = runtimeMinutes(hostile)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(Number.isFinite(minutes), 'still a number')
    assert.ok(elapsedMs < 100, `runtimeMinutes took ${elapsedMs.toFixed(1)}ms on a hostile input`)
  }
  assert.equal(runtimeMinutes(' '.repeat(300_000) + '1h'), 0, 'text past the cap is ignored')
}

// --- F35: restored backup profiles are rebuilt from an allowlist ------------
{
  assert.equal(sanitizeBackupProfile(null), null)
  assert.equal(sanitizeBackupProfile('x'), null)
  assert.equal(sanitizeBackupProfile([]), null)
  assert.equal(sanitizeBackupProfile({}), null)
  assert.equal(sanitizeBackupProfile({ id: 5, name: 'Five' }), null, 'a non-string id is dropped')
  assert.equal(sanitizeBackupProfile({ id: '   ', name: 'Blank' }), null)
  assert.equal(sanitizeBackupProfile({ id: 'x'.repeat(500), name: 'Long' }), null)

  // The scan's crash case: just an id. It comes back complete, not as-is.
  const bare = sanitizeBackupProfile({ id: 'x' })
  assert.ok(bare)
  assert.equal(bare.name, 'Profile')
  assert.equal(bare.avatarInitial, 'P')
  assert.ok(Array.isArray(bare.avatarTint) && bare.avatarTint.length === 2)
  assert.ok(bare.avatarTint.every((c) => /^#[0-9a-f]{6}$/.test(c)))
  assert.equal(bare.isKid, false)
  assert.ok(!Number.isNaN(Date.parse(bare.createdAt)))

  const planted = sanitizeBackupProfile({
    id: 'p1',
    name: '  ' + 'n'.repeat(100),
    avatarTint: ['#FFFFFF', 'red'],
    isKid: 'yes',
    pinHash: 'attacker-hash',
    pinSalt: 'attacker-salt',
    createdAt: { toString: 'boom' },
    extra: { nested: true }
  })
  assert.ok(planted)
  assert.equal(planted.name.length, 40, 'name trimmed and capped')
  assert.equal(planted.avatarInitial, 'N')
  assert.deepEqual(planted.avatarTint, ['#18a9ff', '#8d4dff'], 'an invalid tint gets the default')
  assert.equal(planted.isKid, false, 'only a real boolean true makes a kid profile')
  assert.deepEqual(
    Object.keys(planted).sort(),
    ['avatarInitial', 'avatarTint', 'createdAt', 'id', 'isKid', 'name'],
    'no pinHash/pinSalt or stray keys survive'
  )

  const good = sanitizeBackupProfile({
    id: 'kid',
    name: 'Mia',
    avatarTint: ['#AABBCC', '#112233'],
    isKid: true,
    createdAt: '2024-01-02T03:04:05.000Z'
  })
  assert.deepEqual(good, {
    id: 'kid',
    name: 'Mia',
    avatarInitial: 'M',
    avatarTint: ['#aabbcc', '#112233'],
    isKid: true,
    createdAt: '2024-01-02T03:04:05.000Z'
  })

  assert.deepEqual(sanitizeBackupProfiles('nope'), [])
  const list = sanitizeBackupProfiles([
    { id: 'a', name: 'A' },
    null,
    { id: 'a', name: 'Dup' },
    { id: 'b' }
  ])
  assert.deepEqual(
    list.map((p) => [p.id, p.name]),
    [
      ['a', 'A'],
      ['b', 'Profile']
    ],
    'invalid dropped, duplicates collapse to the first'
  )
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
  assert.equal(sanitizeBackupProfiles(many).length, MAX_BACKUP_PROFILES)

  // Through readBackup, with a real exported file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-misc-hardening-'))
  const db = createDatabase(path.join(dir, 'src.sqlite'), 'alice')
  db.track({ id: 'tt1', type: 'movie', title: 'Dune' })
  const exported = path.join(dir, 'library.json')
  db.exportBackup(exported, {
    appVersion: '1.0.0',
    profiles: [{ id: 'alice', name: 'Alice' }],
    activeProfileId: 'alice'
  })
  const whole = JSON.parse(fs.readFileSync(exported, 'utf8'))

  whole.profiles = [
    { id: 'alice', pinHash: 'h', pinSalt: 's', isKid: 'true', avatarTint: 7 },
    { id: 9 },
    null
  ]
  const crafted = path.join(dir, 'crafted.json')
  fs.writeFileSync(crafted, JSON.stringify(whole), 'utf8')
  const read = readBackup(crafted)
  assert.equal(read.profiles.length, 1, 'malformed entries are dropped before restore')
  const restored = read.profiles[0] as Record<string, unknown>
  assert.equal(restored.id, 'alice')
  assert.equal(restored.name, 'Profile')
  assert.equal(restored.isKid, false)
  assert.equal(restored.pinHash, undefined)
  assert.equal(restored.pinSalt, undefined)
  assert.ok(Array.isArray(restored.avatarTint))

  // Rows owned by a profile that only an INVALID entry declared are refused,
  // rather than restored into a library no valid profile owns.
  whole.profiles = [{ id: ['alice'] }]
  const orphaned = path.join(dir, 'orphaned.json')
  fs.writeFileSync(orphaned, JSON.stringify(whole), 'utf8')
  assert.throws(() => readBackup(orphaned), /no profiles/i)

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('miscHardening tests passed')
