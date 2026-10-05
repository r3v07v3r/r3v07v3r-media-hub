// catalog:search and the index rows a remote find leaves behind, driven
// through the real handler (src/main/media-hub/catalog.ts) with the network
// replaced by a stub.
//
// What is pinned, and why:
//   - a provider that fails (offline, a 429, a 5xx, its timeout) is
//     reported beside the items, so the screens can say "only local
//     results" instead of "no matches"; a caller that does not ask for the
//     report still gets the bare list it always got;
//   - a search reply never waits on a catalogue crawl: on a cold install
//     the only request a search makes is the provider's own search.
//
// catalog.ts imports 'electron' (through ipcGuard), so the module is loaded
// with that name pointed at the headless stand-in (src/headless/
// electronShim), the same alias the phone build uses, and the handler is
// called through that stand-in's ipcMain the way the bridge calls it.
// Run with: npx tsx tests/catalogSearch.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { CatalogItem, CatalogSearchResult } from '../src/shared/media-hub/types'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-catalog-search-'))
process.env.R3_USER_DATA = scratch
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

// ---------------------------------------------------------------------------
// The network. Every request is recorded; how the provider's search answers
// is set per check.
// ---------------------------------------------------------------------------
type ProviderMode = 'answer' | 'fail' | 'down'
let providerMode: ProviderMode = 'answer'
const requests: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  requests.push(url)
  if (url.includes('/top/search=')) {
    if (providerMode === 'down') throw new TypeError('fetch failed')
    if (providerMode === 'fail') return json({ error: 'Too Many Requests' }, 429)
    return json({
      metas: [{ id: 'tt7000001', type: 'movie', name: 'Remote Harbour', poster: '' }]
    })
  }
  throw new TypeError(`no stub for ${url}`)
}) as typeof fetch

const card = (id: string, title: string): CatalogItem =>
  ({ id, type: 'movie', title, videos: [] }) as unknown as CatalogItem

async function main(): Promise<void> {
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const { registerCatalogIpc } = await import('../src/main/media-hub/catalog')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

  const db = createDatabase(path.join(scratch, 'media-hub.sqlite'), 'profile-search-test')
  setDatabase(db)
  // A title the crawl has seen. No catalog blob is written: this install has
  // never finished a crawl, the state a search used to wait out.
  db.indexUpsert('movie', [card('tt6000001', 'Harbour Lights')], { source: 'cinemeta+simkl' })
  registerCatalogIpc()

  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const search = (payload: Record<string, unknown>): Promise<unknown> =>
    ipcMain.dispatchInvoke(event, MEDIA_HUB_CHANNELS.catalogSearch, [payload])
  const ids = (items: CatalogItem[]): string[] => items.map((item) => String(item.id))

  await check('a provider that answers is reachable, and its find is listed', async () => {
    providerMode = 'answer'
    const result = (await search({
      kind: 'movie',
      query: 'harbour',
      report: true
    })) as CatalogSearchResult
    assert.equal(result.providerUnreachable, false)
    assert.deepEqual(ids(result.items).sort(), ['tt6000001', 'tt7000001'])
  })

  await check('a 429 from the provider is reported, with the local hit kept', async () => {
    providerMode = 'fail'
    const result = (await search({
      kind: 'movie',
      query: 'harbour',
      report: true
    })) as CatalogSearchResult
    assert.equal(result.providerUnreachable, true)
    assert.deepEqual(ids(result.items), ['tt6000001'])
  })

  await check('offline with no local hit is "unreachable", not "no matches"', async () => {
    providerMode = 'down'
    const result = (await search({
      kind: 'movie',
      query: 'nowhere',
      report: true
    })) as CatalogSearchResult
    assert.deepEqual(result, { items: [], providerUnreachable: true })
  })

  await check('a caller that does not ask for the report gets the bare list', async () => {
    providerMode = 'down'
    const items = await search({ kind: 'movie', query: 'harbour' })
    assert.ok(Array.isArray(items), 'the answer is still an array')
    assert.deepEqual(ids(items as CatalogItem[]), ['tt6000001'])
    // Under two characters: nothing searched, nothing to report.
    assert.deepEqual(await search({ kind: 'movie', query: 'h', report: true }), {
      items: [],
      providerUnreachable: false
    })
  })

  await check('a search on a cold install makes no request but its own', async () => {
    providerMode = 'answer'
    requests.length = 0
    await search({ kind: 'movie', query: 'harbour', report: true })
    assert.equal(requests.length, 1, `requests: ${requests.join(', ')}`)
    assert.ok(requests[0].includes('/catalog/movie/top/search=harbour'))
  })

  db.close()
  console.log(`\n${pass} checks passed`)
}

void main().then(
  // The scheduler and the stand-in keep timers of their own; the checks are
  // done, so the process is.
  () => process.exit(),
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
