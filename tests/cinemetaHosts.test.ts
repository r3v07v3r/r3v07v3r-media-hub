// Which Cinemeta host a request goes to when the first one cannot be
// reached, driven through the real code (src/main/media-hub/catalog.ts)
// with the network replaced by a stub in which v3-cinemeta is blocked the
// way a DNS filter blocks it and cinemeta-live answers.
//
// What is pinned, and why:
//   - a title's details still come from cinemeta-live, which is the whole
//     reason the second host is there (series lost their episode lists
//     behind Cloudflare's family resolver);
//   - a search asks v3 once and stops: cinemeta-live sends search back to
//     v3, so a second attempt only doubled the wait before the screens
//     could say the provider was unreachable.
//
// catalog.ts imports 'electron' (through ipcGuard), so it is loaded with
// that name pointed at the headless stand-in, as tests/catalogSearch.test.ts
// loads it.
// Run with: npx tsx tests/cinemetaHosts.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { CatalogSearchResult } from '../src/shared/media-hub/types'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-cinemeta-hosts-'))
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

const V3 = 'https://v3-cinemeta.strem.io'
const LIVE = 'https://cinemeta-live.strem.io'
const requests: string[] = []

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  requests.push(url)
  if (url.startsWith(V3)) throw new TypeError('fetch failed')
  if (url.startsWith(LIVE) && url.includes('/top/search=')) {
    return json({ metas: [{ id: 'tt7000001', type: 'movie', name: 'Remote Harbour' }] })
  }
  const meta = url.startsWith(LIVE) && url.match(/\/meta\/movie\/(tt\d+)\.json$/)
  if (meta) {
    return json({ meta: { id: meta[1], type: 'movie', name: 'Remote Harbour', year: '2021' } })
  }
  throw new TypeError(`no stub for ${url}`)
}) as typeof fetch

async function main(): Promise<void> {
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const { metadata, registerCatalogIpc } = await import('../src/main/media-hub/catalog')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

  const db = createDatabase(path.join(scratch, 'media-hub.sqlite'), 'profile-cinemeta-hosts')
  setDatabase(db)
  registerCatalogIpc()
  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const search = (payload: Record<string, unknown>): Promise<unknown> =>
    ipcMain.dispatchInvoke(event, MEDIA_HUB_CHANNELS.catalogSearch, [payload])

  await check('with v3 blocked, a title still opens from cinemeta-live', async () => {
    requests.length = 0
    const opened = await metadata('movie', 'tt7000001')
    assert.equal(opened.title, 'Remote Harbour')
    assert.ok(requests.includes(`${LIVE}/meta/movie/tt7000001.json`))
  })

  await check('with v3 blocked, a search asks it once and not cinemeta-live', async () => {
    requests.length = 0
    const result = (await search({
      kind: 'movie',
      query: 'harbour',
      report: true
    })) as CatalogSearchResult
    assert.equal(result.providerUnreachable, true)
    const searches = requests.filter((url) => url.includes('/top/search='))
    assert.deepEqual(searches, [`${V3}/catalog/movie/top/search=harbour.json`])
  })

  db.close()
  console.log(`\n${pass} checks passed`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

void main()
