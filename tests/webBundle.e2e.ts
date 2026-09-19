// The renderer, built to run with NO Electron shell behind it (`npm run
// build:web`, see vite.web.config.ts), served as a plain static site and
// opened in a real browser — under the app's REAL Content-Security-Policy.
// What this guards is a property the TV and phone apps stand on: the React
// tree boots and routes without window.api, painting honest empty states
// instead of throwing. Nothing else in CI exercised that, so it could rot
// unnoticed.
//
// Served over http rather than opened from file://, because that is how it
// will actually be loaded, and because `script-src 'self'` only means
// something when there is an origin for 'self' to be.
//
// Needs a browser, so it is NOT part of `npm test` — CI runs it in its own
// job (see .github/workflows/verify.yml).
// Run with: npm run build:web && npx tsx tests/webBundle.e2e.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { chromium, type Page } from 'playwright'

const SITE = path.resolve('dist-web')

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** dist-web on a loopback port of the OS's choosing. */
function serveSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    const filePath = path.join(SITE, urlPath === '/' ? 'index.html' : urlPath)
    // Refuse anything that resolves outside the site root.
    if (!filePath.startsWith(SITE) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream'
    })
    res.end(readFileSync(filePath))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

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

/** Everything the page reported as broken while `fn` ran. */
async function problemsDuring(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const problems: string[] = []
  const onPageError = (error: Error): void => void problems.push(`uncaught: ${error.message}`)
  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  try {
    await fn()
  } finally {
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  }
  return problems
}

async function main(): Promise<void> {
  assert.ok(
    existsSync(path.join(SITE, 'index.html')),
    `${SITE} is missing — run "npm run build:web" first`
  )

  const { server, origin } = await serveSite()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

    await check('the bundle boots with no backend and paints the app shell', async () => {
      const problems = await problemsDuring(page, async () => {
        await page.goto(origin)
        await page.waitForSelector('#root > *', { timeout: 15_000 })
        await page.waitForSelector('nav', { timeout: 15_000 })
      })
      assert.deepEqual(problems, [])
      assert.equal(
        await page.evaluate(() => typeof (window as { api?: unknown }).api),
        'undefined',
        'this build must not have a bridge — that is the case under test'
      )
    })

    for (const route of ['/movies', '/series', '/anime', '/my-stuff', '/calendar', '/settings']) {
      await check(`${route} renders without a backend`, async () => {
        const problems = await problemsDuring(page, async () => {
          await page.evaluate((hash) => {
            window.location.hash = hash
          }, `#${route}`)
          // Long enough for the route's effects to run and any rejected
          // promise to surface; there is no network to wait on.
          await page.waitForTimeout(750)
        })
        assert.deepEqual(problems, [])
        assert.ok(
          (await page.locator('#root').innerText()).trim().length > 0,
          'the route painted nothing at all'
        )
      })
    }
  } finally {
    await browser.close()
    server.close()
  }

  console.log(`\n${pass} passed`)
}

void main()
