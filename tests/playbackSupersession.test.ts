// "The latest request wins" for the playback path (playbackSupersession.ts):
// a play the window has moved on from must stop, and must be told apart from
// a copy that genuinely would not open.
// Run with: npx tsx tests/playbackSupersession.test.ts

import assert from 'node:assert'
import {
  assertCurrent,
  createSupersession,
  isSuperseded,
  PlaybackSupersededError
} from '../src/main/media-hub/playbackSupersession'

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

console.log('createSupersession')
check('a ticket is current until something replaces it', () => {
  const s = createSupersession()
  const first = s.take()
  assert.equal(first(), true)
  assert.equal(first(), true, 'checking does not spend it')
})
check('the next request makes the earlier one stale', () => {
  const s = createSupersession()
  const first = s.take()
  const second = s.take()
  assert.equal(first(), false)
  assert.equal(second(), true)
})
check('a stop makes every ticket taken so far stale', () => {
  const s = createSupersession()
  const first = s.take()
  const second = s.take()
  s.supersede()
  assert.equal(first(), false)
  assert.equal(second(), false)
})
check('a request started after a stop is current', () => {
  const s = createSupersession()
  s.supersede()
  assert.equal(s.take()(), true)
})
check('separate supersessions do not end each other', () => {
  const opens = createSupersession()
  const requests = createSupersession()
  const open = opens.take()
  requests.take()
  requests.supersede()
  assert.equal(open(), true)
})

console.log('assertCurrent / isSuperseded')
check('throws the superseded error once stale, and only then', () => {
  const s = createSupersession()
  const ticket = s.take()
  assertCurrent(ticket)
  s.take()
  assert.throws(() => assertCurrent(ticket), PlaybackSupersededError)
})
check('the superseded error is recognised, an ordinary failure is not', () => {
  assert.equal(isSuperseded(new PlaybackSupersededError()), true)
  assert.equal(isSuperseded(new Error('Playback requires a valid HTTPS media URL.')), false)
  assert.equal(isSuperseded('nope'), false)
})
check('recognised by name, as it arrives after crossing a module boundary', () => {
  const copy = new Error('replaced')
  copy.name = 'PlaybackSupersededError'
  assert.equal(isSuperseded(copy), true)
})

// The copy loop's rule, as torbox.ts's playWithLanguageFallback applies it:
// a failed open ends the loop when the request has been replaced, and only
// otherwise moves on to the next copy.
console.log('copy loop')
async function copyLoop(
  copies: string[],
  live: () => boolean,
  open: (copy: string) => Promise<string>
): Promise<{ opened: string[]; result: string }> {
  const opened: string[] = []
  let firstError: unknown = null
  for (const copy of copies) {
    assertCurrent(live)
    try {
      opened.push(copy)
      return { opened, result: await open(copy) }
    } catch (error) {
      if (isSuperseded(error) || !live()) throw new PlaybackSupersededError()
      firstError ??= error
    }
  }
  throw firstError
}

async function asyncChecks(): Promise<void> {
  const s = createSupersession()
  // The S01E05 sequence: copy A is opening when the window cancels.
  const live = s.take()
  await assert.rejects(
    copyLoop(['A', 'B'], live, async (copy) => {
      if (copy === 'A') {
        s.supersede() // playback:stop lands mid-open
        throw new Error('Playback requires a valid HTTPS media URL.')
      }
      return copy
    }),
    PlaybackSupersededError
  )
  pass++
  console.log('  ok  a cancelled play does not go on to open the next copy')

  const s2 = createSupersession()
  const result = await copyLoop(['A', 'B'], s2.take(), async (copy) => {
    if (copy === 'A') throw new Error("That copy wouldn't open")
    return copy
  })
  assert.deepEqual(result, { opened: ['A', 'B'], result: 'B' })
  pass++
  console.log('  ok  a copy that genuinely fails still falls through to the next')
}

asyncChecks()
  .catch((error) => {
    console.log(`FAIL  copy loop\n      ${(error as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => console.log(`\n${pass} passed`))
