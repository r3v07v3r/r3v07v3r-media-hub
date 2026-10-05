// The play-time lookup against a paired cache server (lanCache.ts's
// findLanCacheCandidate), driven against a real local HTTP server. What is
// pinned: the lookup is awaited before TorBox is tried, so a daemon that
// accepts the connection and never answers must cost the play click about
// three seconds, not httpClient's thirty-second default, even when the
// 'lancache' lane is already full of background requests to that same silent
// daemon (the three seconds count from the call, not from dispatch); and a
// daemon that does answer still yields its complete copy.
//
// lanCache.ts imports 'electron' (through ipcGuard), so the module is loaded
// with that name pointed at the headless stand-in (src/headless/electronShim),
// the same alias the phone build uses.
// Run with: npx tsx tests/lanCacheLookup.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-lan-lookup-'))
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

/** A server whose /api/catalog either never answers or answers with one
 *  complete item, depending on `stall`. Returns its base URL. */
function startDaemon(stall: boolean): Promise<{ url: string; close: () => void }> {
  const held: http.ServerResponse[] = []
  const server = http.createServer((req, res) => {
    if (stall) {
      held.push(res)
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        items: [
          {
            contentKey: 'tt0000001::',
            infoHash: 'abc123',
            title: 'A Film',
            fileName: 'A.Film.2020.1080p.mkv',
            resolution: 1080,
            complete: true
          }
        ],
        inFlight: [],
        tombstoned: []
      })
    )
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const res of held) res.destroy()
          server.close()
        }
      })
    })
  })
}

async function main(): Promise<void> {
  const { setLanCacheConnection } = await import('../src/main/media-hub/settingsStore')
  const { findLanCacheCandidate, LAN_LOOKUP_TIMEOUT_MS } =
    await import('../src/main/media-hub/lanCache')

  await check('the lookup gives up on a silent daemon after about three seconds', async () => {
    assert.equal(LAN_LOOKUP_TIMEOUT_MS, 3_000)
    const daemon = await startDaemon(true)
    try {
      setLanCacheConnection({ url: daemon.url, name: 'test', token: 'device-token' })
      const started = Date.now()
      const found = await findLanCacheCandidate('tt0000001::')
      const took = Date.now() - started
      assert.equal(found, null, 'an unanswered lookup contributes nothing')
      assert.ok(took >= LAN_LOOKUP_TIMEOUT_MS - 100, `gave up too early, after ${took} ms`)
      assert.ok(took < LAN_LOOKUP_TIMEOUT_MS + 2_000, `held the play click for ${took} ms`)
    } finally {
      daemon.close()
    }
  })

  await check('the lookup gives up after about three seconds behind a full lane', async () => {
    const { fetchJson } = await import('../src/main/media-hub/httpClient')
    const daemon = await startDaemon(true)
    let background: Promise<unknown>[] = []
    try {
      setLanCacheConnection({ url: daemon.url, name: 'test', token: 'device-token' })
      // Four background calls (the lane's concurrency) that the silent daemon
      // never answers, each holding its slot for httpClient's thirty seconds.
      background = Array.from({ length: 4 }, (_, n) =>
        fetchJson(`${daemon.url}/api/status?n=${n}`, {}, { lane: 'lancache' }).catch(() => null)
      )
      const started = Date.now()
      const found = await findLanCacheCandidate('tt0000001::')
      const took = Date.now() - started
      assert.equal(found, null, 'an unanswered lookup contributes nothing')
      assert.ok(took < LAN_LOOKUP_TIMEOUT_MS + 2_000, `held the play click for ${took} ms`)
    } finally {
      daemon.close()
      await Promise.all(background)
    }
  })

  await check('a daemon that answers still yields its complete copy', async () => {
    const daemon = await startDaemon(false)
    try {
      setLanCacheConnection({ url: daemon.url, name: 'test', token: 'device-token' })
      const found = await findLanCacheCandidate('tt0000001::')
      assert.equal(found?.source, 'lancache')
      assert.equal(found?.infoHash, 'abc123')
      assert.equal(found?.title, 'A.Film.2020.1080p.mkv')
    } finally {
      daemon.close()
    }
  })

  console.log(`\n${pass} checks passed`)
}

void main()
