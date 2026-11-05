// logs/media-hub.log is rolled over to media-hub.log.1 once it passes a few
// megabytes (logger.ts's rollLogIfLarge). Nothing else ever trims it, and a
// failure that repeats every sync pass adds lines each time, so it grew for
// the life of the install, past what a bug report can attach.
//
// logError finds the log through electron's userData, so the module is
// loaded with that name pointed at the headless stand-in (src/headless/
// electronShim), as catalogSearch.test.ts does.
//
// Run with: npx tsx tests/logRotation.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-log-rotation-'))
process.env.R3_USER_DATA = scratch
process.env.R3_ELECTRON_SHIM = '1'
const shim = pathToFileURL(
  path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
    return next(specifier, context)
  }
})

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

async function main(): Promise<void> {
  const { LOG_MAX_BYTES, logError, rollLogIfLarge } = await import('../src/main/media-hub/logger')

  check('a log under the cap is left alone', () => {
    const file = path.join(scratch, 'small.log')
    fs.writeFileSync(file, 'x'.repeat(10))
    rollLogIfLarge(file, 10)
    assert.equal(fs.readFileSync(file, 'utf8').length, 10)
    assert.equal(fs.existsSync(`${file}.1`), false)
  })

  check('a log past the cap becomes .1, replacing an older .1', () => {
    const file = path.join(scratch, 'big.log')
    fs.writeFileSync(`${file}.1`, 'oldest')
    fs.writeFileSync(file, 'x'.repeat(11))
    rollLogIfLarge(file, 10)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(11))
  })

  check('no log yet is not an error', () => {
    rollLogIfLarge(path.join(scratch, 'none.log'), 10)
  })

  check('logError starts a fresh file once the log is past the cap', () => {
    const logs = path.join(scratch, 'logs')
    const file = path.join(logs, 'media-hub.log')
    logError('test', 'first line')
    assert.match(fs.readFileSync(file, 'utf8'), /\[test\] first line/)
    fs.appendFileSync(file, 'x'.repeat(LOG_MAX_BYTES))
    logError('test', 'after the cap')
    const fresh = fs.readFileSync(file, 'utf8')
    assert.match(fresh, /\[test\] after the cap/)
    assert.doesNotMatch(fresh, /first line/)
    assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /first line/)
  })

  console.log(`\n${pass} passed`)
}

void main()
