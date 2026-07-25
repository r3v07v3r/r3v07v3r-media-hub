// Builds (if needed) and serves the app's static output on a local
// ephemeral port, then uses Playwright to visit each configured route,
// capture console errors + failed network requests, and screenshot it
// into .ai/screenshots/current/. No Electron/CDP juggling required: the
// renderer build (out/renderer, dist, etc.) is just a static site, so a
// plain `http.createServer` + headless Chromium is enough, and it's the
// same approach in every project this framework is copied into.
//
// Deliberately simple per the spec this framework was built from: no
// animation-specific machinery beyond an optional per-route
// `captureOffsetsMs` list (defaults to a single screenshot at 0ms).

import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_DIR,
  ROOT,
  ensureDir,
  loadConfig,
  log,
  runCommand,
  section,
  writeJSON
} from './ai-utils.js'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const CANDIDATE_SERVE_DIRS = ['out/renderer', 'dist', 'build', 'preview-dist']

function resolveServeDir(configured?: string): string | null {
  if (configured) {
    const p = path.join(ROOT, configured)
    return existsSync(path.join(p, 'index.html')) ? p : null
  }
  for (const candidate of CANDIDATE_SERVE_DIRS) {
    const p = path.join(ROOT, candidate)
    if (existsSync(path.join(p, 'index.html'))) return p
  }
  return null
}

function startStaticServer(serveDir: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    let filePath = path.join(serveDir, urlPath)
    if (!existsSync(filePath) || filePath.endsWith(path.sep)) {
      // SPA fallback — client-side routing means most paths won't exist on disk.
      filePath = path.join(serveDir, 'index.html')
    }
    const ext = path.extname(filePath)
    try {
      const data = readFileSync(filePath)
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, port })
    })
  })
}

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH
  // Sandbox-specific convenience: this container ships a pre-installed
  // Chromium at this fixed path so `npm install` doesn't need to fetch
  // one. Harmless everywhere else — the check just won't match.
  const sandboxChromium = '/opt/pw-browsers/chromium'
  if (existsSync(sandboxChromium)) return sandboxChromium
  return undefined
}

export interface RouteResult {
  name: string
  url: string
  screenshots: string[]
  consoleErrors: string[]
  failedRequests: string[]
}

export interface ScreenshotReport {
  enabled: boolean
  serveDir: string | null
  routes: RouteResult[]
  error?: string
  generatedAt: string
}

export async function runScreenshots(opts: { verbose?: boolean } = {}): Promise<ScreenshotReport> {
  const config = loadConfig()
  if (opts.verbose) section('Screenshots')

  if (!config.screenshots.enabled) {
    if (opts.verbose) log('Screenshots disabled in .ai/config.json — skipping.')
    return { enabled: false, serveDir: null, routes: [], generatedAt: new Date().toISOString() }
  }

  let serveDir = resolveServeDir(config.screenshots.serveDir)
  if (!serveDir) {
    if (opts.verbose) log('No build output found — running `npm run build` once...')
    const buildResult = runCommand('build-for-screenshots', 'npm', ['run', 'build'])
    if (!buildResult.success) {
      const report: ScreenshotReport = {
        enabled: true,
        serveDir: null,
        routes: [],
        error: `Build failed, cannot capture screenshots:\n${buildResult.stderr.slice(-1500)}`,
        generatedAt: new Date().toISOString()
      }
      writeJSON(path.join(AI_DIR, 'reports', 'screenshots-latest.json'), report)
      return report
    }
    serveDir = resolveServeDir(config.screenshots.serveDir)
  }
  if (!serveDir) {
    const report: ScreenshotReport = {
      enabled: true,
      serveDir: null,
      routes: [],
      error:
        'No servable build output found (checked out/renderer, dist, build, preview-dist). ' +
        'Set screenshots.serveDir in .ai/config.json to point at your built static output.',
      generatedAt: new Date().toISOString()
    }
    writeJSON(path.join(AI_DIR, 'reports', 'screenshots-latest.json'), report)
    return report
  }

  let playwright: typeof import('playwright')
  try {
    playwright = await import('playwright')
  } catch {
    const report: ScreenshotReport = {
      enabled: true,
      serveDir,
      routes: [],
      error: 'playwright is not installed. Run `npm install` (it is a devDependency) and, if needed, `npx playwright install chromium`.',
      generatedAt: new Date().toISOString()
    }
    writeJSON(path.join(AI_DIR, 'reports', 'screenshots-latest.json'), report)
    return report
  }

  const { server, port } = await startStaticServer(serveDir)
  const outDir = path.join(AI_DIR, 'screenshots', 'current')
  ensureDir(outDir)

  const executablePath = resolveChromiumExecutable()
  const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {})
  const routes: RouteResult[] = []

  try {
    for (const route of config.screenshots.routes) {
      const page = await browser.newPage({ viewport: config.screenshots.viewport })
      const consoleErrors: string[] = []
      const failedRequests: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })
      page.on('requestfailed', (req) => {
        failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown error'}`)
      })

      if (opts.verbose) log(`capturing: ${route.name} (${route.url})`)
      await page.goto(`http://127.0.0.1:${port}${route.url}`, { waitUntil: 'networkidle' }).catch((err) => {
        consoleErrors.push(`navigation error: ${(err as Error).message}`)
      })

      const offsets = route.captureOffsetsMs && route.captureOffsetsMs.length > 0 ? route.captureOffsetsMs : [0]
      const shots: string[] = []
      let elapsed = 0
      for (const offset of offsets) {
        const wait = Math.max(0, offset - elapsed) || config.screenshots.settleMs || 0
        if (wait > 0) await page.waitForTimeout(wait)
        elapsed += wait
        const suffix = offsets.length > 1 ? `@${offset}ms` : ''
        const fileName = `${route.name}${suffix}.png`
        const filePath = path.join(outDir, fileName)
        await page.screenshot({ path: filePath, fullPage: true })
        shots.push(path.relative(ROOT, filePath))
      }

      routes.push({ name: route.name, url: route.url, screenshots: shots, consoleErrors, failedRequests })
      await page.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  const report: ScreenshotReport = { enabled: true, serveDir, routes, generatedAt: new Date().toISOString() }
  writeJSON(path.join(AI_DIR, 'reports', 'screenshots-latest.json'), report)
  return report
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  runScreenshots({ verbose: true }).then((report) => {
    section('Screenshot summary')
    if (report.error) {
      log(`error: ${report.error}`)
      process.exit(1)
    }
    for (const r of report.routes) {
      log(`${r.name}: ${r.screenshots.join(', ')} (${r.consoleErrors.length} console errors, ${r.failedRequests.length} failed requests)`)
    }
    process.exit(0)
  })
}
