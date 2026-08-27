// Backup and restore, through the real database API.
//
// The interesting cases are all about what a restore must NOT do: leak a PIN,
// carry the refetchable cache, half-apply a bad file, or silently drop rows a
// schema change has moved on from.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { readBackup } from '../src/main/media-hub/backup'

const ALICE = 'profile-alice'
const BOB = 'profile-bob'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r3-backup-'))
}

const dir = tempDir()
const source = path.join(dir, 'source.sqlite')
const backupFile = path.join(dir, 'library.json')

// A library with two profiles in it, so the backup has to carry more than
// whoever happens to be active.
const db = createDatabase(source, ALICE)
db.track({ id: 'tt1', type: 'movie', title: 'Dune' })
db.markWatched({ id: 'tt1', type: 'movie', title: 'Dune' })
db.markWatched({ id: 'tt1', type: 'movie', title: 'Dune' }) // a rewatch: two plays
db.dislike({ id: 'tt3', type: 'movie', title: 'Cats' })
db.savePlaybackPosition('tt2', { season: 1, episode: 4 }, 600, 2400, 1.4)
db.putCache('meta:tt1', { big: 'refetchable' }, 60_000)

db.setActiveProfile(BOB)
db.track({ id: 'tt9', type: 'series', title: 'Andor' })
db.setActiveProfile(ALICE)

db.exportBackup(backupFile, {
  appVersion: '1.2.3',
  profiles: [
    { id: ALICE, name: 'Alice', pinHash: 'SECRET-HASH', pinSalt: 'SECRET-SALT' },
    { id: BOB, name: 'Bob' }
  ],
  activeProfileId: ALICE
})

// ---------------------------------------------------------------------
// What the file does and does not contain.
// ---------------------------------------------------------------------
{
  const raw = fs.readFileSync(backupFile, 'utf8')
  assert.ok(!raw.includes('SECRET-HASH'), 'a PIN hash never reaches a backup file')
  assert.ok(!raw.includes('SECRET-SALT'), 'nor its salt')
  assert.ok(!raw.includes('refetchable'), 'the catalog cache is not backed up')

  const backup = readBackup(backupFile)
  assert.equal(backup.appVersion, '1.2.3')
  assert.equal(backup.profiles.length, 2, 'both profiles travel, not just the active one')
  assert.equal(backup.tables.tracked.length, 2, "Alice's title and Bob's")
  assert.equal(backup.tables.plays.length, 2, 'both plays of the rewatched movie')
  assert.equal(backup.tables.playback_positions.length, 1)

  // No leftover temp file from the write-and-rename.
  assert.ok(!fs.existsSync(`${backupFile}.partial`))
}

// ---------------------------------------------------------------------
// Restoring into an install that has its own, different library.
// ---------------------------------------------------------------------
{
  const target = path.join(dir, 'target.sqlite')
  const fresh = createDatabase(target, ALICE)
  fresh.track({ id: 'tt-local', type: 'movie', title: 'Something else' })
  fresh.putCache('meta:local', { keep: 'me' }, 60_000)
  assert.equal(fresh.tracked().length, 1)

  const summary = fresh.importBackup(backupFile)

  // Restore REPLACES: the local title is gone, the backup's are here.
  assert.equal(fresh.tracked().length, 1, 'Alice has exactly her backed-up title')
  assert.equal(fresh.isTracked('tt1'), true)
  assert.equal(fresh.isTracked('tt-local'), false, 'the pre-restore library was replaced')
  assert.equal(fresh.playCounts().get('tt1'), 2, 'the rewatch survived the round trip')
  assert.equal(fresh.getPlaybackPosition('tt2', { season: 1, episode: 4 })?.volume, 1.4)
  assert.equal(fresh.disliked().length, 1)

  // Profile scoping survives too — Bob's row came back as Bob's.
  fresh.setActiveProfile(BOB)
  assert.equal(fresh.isTracked('tt9'), true)
  assert.equal(fresh.isTracked('tt1'), false, "Alice's title did not become everyone's")
  fresh.setActiveProfile(ALICE)

  // The cache is not part of a backup and is not collateral damage either.
  assert.deepEqual(fresh.getCache('meta:local'), { keep: 'me' })

  assert.equal(summary.restored.tracked, 2)
  assert.equal(summary.profiles, 2)
  // A restore says who to switch back to, so "restore" means putting things
  // back the way they were rather than replacing the data and leaving somebody
  // else's library on screen.
  assert.equal(summary.activeProfileId, ALICE)
  fresh.close()
}

// ---------------------------------------------------------------------
// A backup written before that field existed still restores, landing on the
// first profile it declares rather than staying wherever it happened to be.
// ---------------------------------------------------------------------
{
  const legacy = path.join(dir, 'legacy.json')
  const parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  delete parsed.activeProfileId
  fs.writeFileSync(legacy, JSON.stringify(parsed), 'utf8')

  const target = createDatabase(path.join(dir, 'legacy.sqlite'), BOB)
  assert.equal(target.importBackup(legacy).activeProfileId, ALICE)

  // And an id naming somebody the file does not contain is not honoured —
  // switching into a library that is not there is worse than not switching.
  const bogus = path.join(dir, 'bogus-active.json')
  fs.writeFileSync(bogus, JSON.stringify({ ...parsed, activeProfileId: 'nobody-here' }), 'utf8')
  assert.equal(target.importBackup(bogus).activeProfileId, ALICE)
  target.close()
}

// ---------------------------------------------------------------------
// Files that must be refused, and refused without changing anything.
// ---------------------------------------------------------------------
{
  const target = path.join(dir, 'refuse.sqlite')
  const guarded = createDatabase(target, ALICE)
  guarded.track({ id: 'tt-keep', type: 'movie', title: 'Untouched' })

  const notABackup = path.join(dir, 'notes.json')
  fs.writeFileSync(notABackup, JSON.stringify({ hello: 'world' }), 'utf8')
  assert.throws(() => guarded.importBackup(notABackup), /not an R3 Media Hub backup/i)

  const unreadable = path.join(dir, 'broken.json')
  fs.writeFileSync(unreadable, 'not json at all', 'utf8')
  assert.throws(() => guarded.importBackup(unreadable), /could not be read/i)

  // A backup from a future schema is refused rather than restored with the
  // columns this build has never heard of quietly dropped.
  const future = path.join(dir, 'future.json')
  const parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  fs.writeFileSync(future, JSON.stringify({ ...parsed, schemaVersion: 999 }), 'utf8')
  assert.throws(() => guarded.importBackup(future), /newer version/i)

  // A file with the right marker and version but no CONTENTS. This is the one
  // that mattered: restore deletes every table before writing any of them and
  // reads a missing table as "zero rows", so without validation a structurally
  // damaged backup emptied the library and committed it as a success.
  const hollow = path.join(dir, 'hollow.json')
  fs.writeFileSync(
    hollow,
    JSON.stringify({
      format: 'r3-media-hub-backup',
      version: 1,
      schemaVersion: 1,
      profiles: [],
      tables: {}
    }),
    'utf8'
  )
  assert.throws(() => guarded.importBackup(hollow), /incomplete/i)

  // One missing table is the same failure, and is named.
  const partial = path.join(dir, 'partial.json')
  const whole = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  delete whole.tables.ratings
  fs.writeFileSync(partial, JSON.stringify(whole), 'utf8')
  assert.throws(() => guarded.importBackup(partial), /ratings/i)

  // Missing profiles is refused BEFORE the restore, not after: that field is
  // read once the transaction has already committed, so a late throw would
  // leave a replaced library owned by nobody.
  const noProfiles = path.join(dir, 'no-profiles.json')
  const stripped = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  delete stripped.profiles
  fs.writeFileSync(noProfiles, JSON.stringify(stripped), 'utf8')
  assert.throws(() => guarded.importBackup(noProfiles), /profiles/i)

  // An array of profiles is not the same as a USABLE one. Every row in every
  // table is owned by a profile id, so a file with none describes a library
  // nobody can reach — restoring it would delete what is here, write orphans,
  // and report success.
  for (const [name, profiles] of [
    ['empty-profiles', []],
    ['idless-profiles', [{ name: 'No id' }]],
    ['blank-id', [{ id: '   ' }]]
  ] as const) {
    const file = path.join(dir, `${name}.json`)
    const copy = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
    copy.profiles = profiles
    fs.writeFileSync(file, JSON.stringify(copy), 'utf8')
    assert.throws(() => guarded.importBackup(file), /no profiles/i, name)
  }

  // One valid-looking profile, but rows owned by somebody else. Nothing above
  // catches this — the tables are present and non-empty and the profile array
  // has an entry — yet restoring it would delete the library and write rows no
  // profile can reach.
  const orphaned = path.join(dir, 'orphaned.json')
  const wrongOwner = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  wrongOwner.profiles = [{ id: 'somebody-else', name: 'Nobody here' }]
  fs.writeFileSync(orphaned, JSON.stringify(wrongOwner), 'utf8')
  assert.throws(() => guarded.importBackup(orphaned), /does not include/i)

  // A list_item whose parent list is not in the file is the same failure,
  // reached through the one table that has no profile column of its own.
  const strayItem = path.join(dir, 'stray-item.json')
  const withStray = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  withStray.tables.list_items = [
    { list_id: 'no-such-list', content_id: 'tt1', sort_order: 0, added_at: '', metadata_json: '{}' }
  ]
  fs.writeFileSync(strayItem, JSON.stringify(withStray), 'utf8')
  assert.throws(() => guarded.importBackup(strayItem), /list_items/i)

  assert.equal(guarded.isTracked('tt-keep'), true, 'no refused file changed anything')
  assert.equal(guarded.tracked().length, 1, 'and nothing was deleted on the way to refusing')
  guarded.close()
}

// ---------------------------------------------------------------------
// A backup whose rows lack a column this build has is restorable — the
// column takes its default rather than the restore failing.
// ---------------------------------------------------------------------
{
  const older = path.join(dir, 'older.json')
  const parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  for (const row of parsed.tables.tracked) delete row.baseline_episode
  parsed.schemaVersion = 1
  fs.writeFileSync(older, JSON.stringify(parsed), 'utf8')

  const target = path.join(dir, 'older.sqlite')
  const restored = createDatabase(target, ALICE)
  restored.importBackup(older)
  assert.equal(restored.isTracked('tt1'), true, 'an older backup still restores')
  restored.close()
}

db.close()
console.log('backup tests passed')
