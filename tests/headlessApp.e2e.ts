// The whole app with no Electron anywhere in it: the service layer as a plain
// Node process (npm run build:headless), the renderer as a static bundle (npm
// run build:web), a real browser between them. This is the shape the TV and
// phone apps run in, and this test is what keeps it standing while the desktop
// app changes underneath it every day.
//
// It asserts only on what needs no network — a fresh profile's first-run
// flow, the profile list, settings — so an upstream catalogue being slow or
// down can never turn CI red.
//
// Needs a browser and both builds, so it is NOT part of `npm test`; CI runs it
// in the "Web bundle checks" job.
// Run with: npm run build:web && npm run build:headless && npx tsx tests/headlessApp.e2e.ts

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const BACKEND = path.resolve('dist-headless/backend.cjs')
const SITE = path.resolve('dist-web')

let pass = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

interface Running {
  child: ChildProcess
  origin: string
  launchUrl: string
}

/** Starts the backend and waits for the one line it prints when it is up. */
function startBackend(userData: string, port: number): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BACKEND], {
      env: {
        ...process.env,
        R3_USER_DATA: userData,
        R3_SITE_DIR: SITE,
        R3_BRIDGE_PORT: String(port)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const onData = (chunk: Buffer): void => {
      output += String(chunk)
      const ready = output.match(/\[headless\] ready (\{.*\})/)
      if (!ready) return
      const { origin, launchUrl } = JSON.parse(ready[1]) as { origin: string; launchUrl: string }
      resolve({ child, origin, launchUrl })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) =>
      reject(new Error(`backend exited (${code}) before it was ready:\n${output}`))
    )
    setTimeout(() => reject(new Error(`backend not ready after 30s:\n${output}`)), 30_000)
  })
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

/** A free loopback port, so a restart can come back on the SAME origin — the
 *  page's cookie and its reconnect both depend on that. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function main(): Promise<void> {
  assert.ok(fs.existsSync(BACKEND), `${BACKEND} is missing — run "npm run build:headless" first`)
  assert.ok(
    fs.existsSync(path.join(SITE, 'index.html')),
    `${SITE} is missing — run "npm run build:web" first`
  )

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-headless-e2e-'))
  const port = await freePort()
  let backend = await startBackend(userData, port)
  const browser = await chromium.launch()

  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    const uncaught: string[] = []
    page.on('pageerror', (error) => uncaught.push(error.message))

    await check('the launch link signs the browser in and leaves nothing in the URL', async () => {
      await page.goto(backend.launchUrl)
      await page.waitForFunction(() => 'api' in window, undefined, { timeout: 15_000 })
      assert.equal(page.url(), `${backend.origin}/`)
    })

    await check('the page has the full backend surface, built over the bridge', async () => {
      const namespaces = await page.evaluate(
        () => Object.keys((window as unknown as { api: { mediaHub: object } }).api.mediaHub).length
      )
      assert.ok(namespaces >= 30, `only ${namespaces} namespaces on window.api.mediaHub`)
    })

    await check(
      'a fresh profile gets the real first-run flow, which only a backend can ask for',
      async () => {
        // Without a backend the app skips straight to empty states; this dialog
        // appears because the BACKEND said setup has not been completed.
        await page.getByText('Welcome to R3').waitFor({ timeout: 15_000 })
      }
    )

    await check('a write through the bridge is there to read back', async () => {
      await page.getByPlaceholder('e.g. Graham').fill('Headless E2E')
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByText('Where should video come from?').waitFor({ timeout: 15_000 })
      const names = await page.evaluate(async () => {
        const api = (
          window as unknown as {
            api: {
              mediaHub: { profiles: { list(): Promise<{ profiles: Array<{ name: string }> }> } }
            }
          }
        ).api
        return (await api.mediaHub.profiles.list()).profiles.map((profile) => profile.name)
      })
      assert.deepEqual(names, ['Headless E2E'])
    })

    await check('when the backend dies, the page says so instead of looking fine', async () => {
      await page.evaluate(() => ((window as unknown as { marker: string }).marker = 'before'))
      await kill(backend.child)
      await page.getByText('Reconnecting to the app’s backend').waitFor({ timeout: 15_000 })
    })

    await check('when it comes back as a new process, the page recovers by itself', async () => {
      backend = await startBackend(userData, port)
      // Reconnected with its remembered cookie, saw a different boot nonce,
      // and reloaded — so the marker set before the restart is gone.
      await page.waitForFunction(() => !('marker' in window) && 'api' in window, undefined, {
        timeout: 30_000
      })
      const names = await page.evaluate(async () => {
        const api = (
          window as unknown as {
            api: {
              mediaHub: { profiles: { list(): Promise<{ profiles: Array<{ name: string }> }> } }
            }
          }
        ).api
        return (await api.mediaHub.profiles.list()).profiles.map((profile) => profile.name)
      })
      assert.deepEqual(
        names,
        ['Headless E2E'],
        'the profile written before the kill should still be there'
      )
      assert.equal(await page.getByText('Reconnecting to the app’s backend').count(), 0)
    })

    await check('nothing threw along the way', async () => {
      assert.deepEqual(uncaught, [])
    })
  } finally {
    await browser.close()
    await kill(backend.child)
  }

  console.log(`\n${pass} passed`)
}

void main()
