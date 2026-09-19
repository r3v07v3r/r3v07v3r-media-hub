// What a library write is worth when the process dies without saying goodbye.
//
// On the desktop the database is closed in an orderly `before-quit`. That is a
// courtesy, not something the data may depend on: a crash, a force-quit or the
// power button skips it — and on a phone or a TV the operating system kills a
// backgrounded process as a matter of routine, with no callback at all. So the
// promise has to be the stronger one: once a write has returned, it is on disk,
// close() or no close().
//
// The write happens in a CHILD process that then kills itself outright, which
// is the only honest way to test this — anything in-process gets to run exit
// handlers and flush on the way out.
// Run with: npx tsx tests/databaseKillSurvival.test.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'

const PROFILE = 'profile-kill-test'
const EPISODE = { season: 1, episode: 4 }

// ---------------------------------------------------------------------
// The child: write, then die before anything can tidy up.
// ---------------------------------------------------------------------
if (process.argv[2] === '--write-then-die') {
  const db = createDatabase(process.argv[3], PROFILE)
  db.track({ id: 'tt2', type: 'series', title: 'Severance' })
  db.savePlaybackPosition('tt2', EPISODE, 600, 2400)
  // No close(). SIGKILL cannot be caught, so no exit handler, no finally, no
  // flush-on-the-way-out runs after this line.
  process.kill(process.pid, 'SIGKILL')
}

// ---------------------------------------------------------------------
// The parent.
// ---------------------------------------------------------------------
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

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-db-kill-')), 'media-hub.sqlite')

// The same interpreter and loader this test is running under (tsx registers
// itself through execArgv), so the child can import the TypeScript source too.
const child = spawnSync(
  process.execPath,
  [...process.execArgv, __filename, '--write-then-die', file],
  { encoding: 'utf8' }
)

check('the writer really was killed, not allowed to exit', () => {
  // A clean exit would make everything below meaningless. POSIX reports the
  // signal; Windows has no signals and reports a non-zero status instead.
  const killed = child.signal === 'SIGKILL' || (child.status !== null && child.status !== 0)
  assert.ok(killed, `child exited cleanly (status ${child.status}): ${child.stderr}`)
})

check('it left the database unclosed — the write-ahead log is still there', () => {
  // An orderly close() checkpoints the WAL away. Finding it proves the kill
  // landed before any such thing, i.e. that this is the case under test.
  assert.ok(fs.existsSync(`${file}-wal`), 'no -wal file: the database was closed cleanly')
})

check('the resume point and the library row are both there on the next launch', () => {
  const db = createDatabase(file, PROFILE)
  try {
    assert.equal(db.isTracked('tt2'), true, 'the tracked title did not survive')
    const resume = db.getPlaybackPosition('tt2', EPISODE)
    assert.ok(resume, 'the resume point did not survive')
    assert.equal(resume.positionSeconds, 600)
  } finally {
    db.close()
  }
})

console.log(`\n${pass} passed`)
