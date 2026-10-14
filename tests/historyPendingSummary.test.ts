// The Watchlists panel's line about watched changes that have not reached a
// service yet (tracking.ts's summarizeHistoryPending).
//
// The owed record has one entry per service, title and episode (per season
// for MyAnimeList, historyRetry.ts's historyPushKey), so its raw count made
// one season marked offline, with Simkl and Trakt connected, read as two
// dozen "watched changes". The panel now says how many titles and which
// services, and that is what is pinned here.
//
// tracking.ts imports 'electron' (through ipcGuard), so the module is loaded
// with that name pointed at the headless stand-in, as catalogSearch.test.ts
// does.
// Run with: npx tsx tests/historyPendingSummary.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PendingHistoryPush } from '../src/main/media-hub/historyRetry'

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-history-pending-'))
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

function owed(
  service: PendingHistoryPush['service'],
  id: string,
  season: number | null,
  episode: number | null
): [string, PendingHistoryPush] {
  return [
    `${service}|${id}|${season}|${episode}`,
    {
      service,
      action: 'add',
      item: { id, type: season === null ? 'movie' : 'series', title: id },
      season,
      episode,
      attempts: 1,
      at: 1,
      mark: 'm'
    }
  ]
}

async function main(): Promise<void> {
  const { summarizeHistoryPending } = await import('../src/main/media-hub/tracking')

  // Nothing owed.
  assert.deepEqual(summarizeHistoryPending({}), { titles: 0, services: [] })

  // A twelve-episode season marked offline with Simkl and Trakt connected,
  // and a film owed to Trakt: 25 entries, two titles, two services.
  const pending = Object.fromEntries([
    ...Array.from({ length: 12 }, (_, i) => owed('simkl', 'tt-show', 1, i + 1)),
    ...Array.from({ length: 12 }, (_, i) => owed('trakt', 'tt-show', 1, i + 1)),
    owed('trakt', 'tt-film', null, null)
  ])
  assert.equal(Object.keys(pending).length, 25)
  assert.deepEqual(summarizeHistoryPending(pending), { titles: 2, services: ['simkl', 'trakt'] })

  // One service only is named alone.
  assert.deepEqual(summarizeHistoryPending(Object.fromEntries([owed('mal', 'kitsu:1', 2, null)])), {
    titles: 1,
    services: ['mal']
  })

  console.log('history pending summary tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
