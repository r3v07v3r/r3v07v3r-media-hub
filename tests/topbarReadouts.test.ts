// The top bar's readouts sit in the main chrome, in front of every user in
// every session, so each one has to be REAL. It once carried a weather readout
// that was a mock: a fixed 21° shown after a pretend 700 ms "lookup". These
// checks read the source, so a made-up readout cannot quietly come back.
// Run with: npx tsx tests/topbarReadouts.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const rendererDir = path.join(root, 'src/renderer/src')

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.(ts|tsx|css)$/.test(entry.name)) found.push(full)
  }
  return found
}

async function main(): Promise<void> {
  await check('the mock weather hook is gone', () => {
    assert.ok(
      !fs.existsSync(path.join(root, 'src/renderer/src/hooks/useWeather.ts')),
      'src/renderer/src/hooks/useWeather.ts still exists'
    )
  })

  await check('the top bar shows no weather readout', () => {
    const source = fs.readFileSync(
      path.join(rendererDir, 'components/topbar/UserEnvironmentStatus.tsx'),
      'utf8'
    )
    for (const needle of ['useWeather', 'Loading weather', 'tempC', 'name="weather"']) {
      assert.ok(!source.includes(needle), `UserEnvironmentStatus.tsx still contains ${needle}`)
    }
  })

  await check('nothing in the renderer references the weather mock', () => {
    const offenders = sourceFiles(rendererDir)
      .filter((file) =>
        /\buseWeather\b|\bWeatherSnapshot\b|styles\.weather/.test(fs.readFileSync(file, 'utf8'))
      )
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
    assert.ok(offenders.length === 0, `still referenced in: ${offenders.join(', ')}`)
  })

  console.log(`\n${pass} passed`)
}

void main()
