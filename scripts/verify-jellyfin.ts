/**
 * Live verification of the media-server playback path against a real
 * Jellyfin instance. Everything else about this feature is covered by unit
 * tests; this is the part that cannot be — the response shapes of someone
 * else's server, and whether the URL we build actually serves bytes.
 *
 * Reads credentials from the environment so no key is ever written to a
 * file, committed, or pasted into a conversation:
 *
 *   JELLYFIN_BASE_URL=http://192.168.88.237:8096 \
 *   JELLYFIN_API_KEY=... \
 *   npx tsx scripts/verify-jellyfin.ts "Some Movie Title"
 *
 * Read-only against the server: it searches, reads metadata, and requests
 * the first few KB of one file. It never writes to the library.
 */

import {
  buildStreamUrl,
  findEpisode,
  findMovie,
  isJellyfinConfigured,
  jellyfinCandidate,
  type JellyfinConfig,
  type JellyfinItem
} from '../src/main/media-hub/jellyfin'
import { assertPlayableUrl } from '../src/main/media-hub/mpv'
import { rankStreams } from '../src/main/media-hub/core'
import { clearTrustedMediaHosts, setTrustedMediaHosts } from '../src/main/media-hub/playback'
import type { StreamCandidate } from '../src/shared/media-hub/types'

const baseUrl = process.env.JELLYFIN_BASE_URL ?? ''
const apiKey = process.env.JELLYFIN_API_KEY ?? ''
// An argument shaped like an IMDb id exercises the provider-id path the
// app actually uses; anything else exercises the title-search fallback.
const arg = process.argv[2] ?? ''
const isImdbId = /^tt\d+$/.test(arg)
const searchImdbId = isImdbId ? arg : ''
const searchTitle = isImdbId ? '' : arg
const seasonArg = Number(process.argv[3])
const episodeArg = Number(process.argv[4])

const config: JellyfinConfig = { baseUrl, apiKey }

let failures = 0
function pass(message: string): void {
  console.log(`  ok    ${message}`)
}
function fail(message: string, detail?: unknown): void {
  failures += 1
  console.log(`  FAIL  ${message}`)
  if (detail !== undefined) console.log(`        ${String(detail)}`)
}

/** The key must never reach stdout — this output is likely to be pasted. */
function redact(value: string): string {
  return apiKey ? value.split(apiKey).join('<redacted>') : value
}

async function main(): Promise<void> {
  console.log('\nJellyfin live verification\n')

  if (!isJellyfinConfigured(config)) {
    console.log('  Set JELLYFIN_BASE_URL and JELLYFIN_API_KEY before running.')
    console.log('  Example:')
    console.log('    JELLYFIN_BASE_URL=http://192.168.88.237:8096 \\')
    console.log('    JELLYFIN_API_KEY=xxxxx \\')
    console.log('    npx tsx scripts/verify-jellyfin.ts "The Matrix"\n')
    process.exitCode = 1
    return
  }

  console.log(`  server  ${baseUrl}`)
  console.log(`  lookup  ${isImdbId ? `imdb ${searchImdbId}` : searchTitle || '(none given)'}
`)

  // --- 1. The server answers, and the key is actually accepted -----------
  // /System/Info requires a valid token, unlike /System/Info/Public which
  // answers regardless and so can never test a credential.
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/System/Info`, {
      headers: { 'X-Emby-Token': apiKey, Accept: 'application/json' }
    })
    if (!res.ok) {
      fail(`authenticated request rejected (HTTP ${res.status})`)
      if (res.status === 401) console.log('        the API key was not accepted')
      process.exitCode = 1
      return
    }
    const info = (await res.json()) as { ServerName?: string; Version?: string }
    pass(`authenticated as a real client — ${info.ServerName ?? '?'} v${info.Version ?? '?'}`)
  } catch (error) {
    fail('could not reach the server at all', (error as Error).message)
    process.exitCode = 1
    return
  }

  if (!searchTitle && !searchImdbId) {
    console.log('\n  Pass a title to exercise lookup and playback.\n')
    return
  }

  // --- 2. Lookup returns something with a playable media source ----------
  const episodic = Number.isFinite(seasonArg) && Number.isFinite(episodeArg)
  let item: JellyfinItem | null = null
  try {
    item = episodic
      ? await findEpisode(config, searchImdbId, searchTitle, seasonArg, episodeArg)
      : await findMovie(config, searchImdbId, searchTitle)
  } catch (error) {
    fail('lookup threw', (error as Error).message)
  }

  if (!item) {
    fail(`no ${episodic ? 'episode' : 'movie'} found for "${searchImdbId || searchTitle}"`)
    console.log('        (the title guard is strict — it must match the library name)')
    process.exitCode = 1
    return
  }
  pass(`found "${item.Name}"${item.SeriesName ? ` (${item.SeriesName})` : ''}`)

  // --- 3. It converts to a candidate with real quality data --------------
  const candidate = jellyfinCandidate(item)
  if (!candidate) {
    fail('the item produced no candidate — no usable MediaSources')
    process.exitCode = 1
    return
  }
  pass('converted to a stream candidate')
  console.log(`        name        ${candidate.name}`)
  console.log(`        resolution  ${candidate.resolution || '(unknown)'}`)
  console.log(
    `        size        ${
      candidate.sizeBytes
        ? `${(Number(candidate.sizeBytes) / 1024 ** 3).toFixed(2)} GB`
        : '(unknown)'
    }`
  )
  console.log(`        audio       ${JSON.stringify(candidate.audioLanguages ?? [])}`)

  if (!candidate.resolution) {
    fail('resolution came back 0 — MediaStreams Width/Height were not as expected')
  }

  // --- 4. Ranking treats it as instantly available -----------------------
  const remote: StreamCandidate = {
    infoHash: 'f'.repeat(40),
    name: 'Some Release 1080p WEB-DL',
    cached: true,
    compatible: true
  }
  const balanced = rankStreams([remote, candidate], 'en', {}, 'balanced')[0]
  if (balanced.source === 'mediaserver') pass('balanced ranking prefers the local copy')
  else fail('balanced ranking did not prefer the local copy')

  // --- 5. The URL passes the gate mpv enforces ---------------------------
  const streamUrl = buildStreamUrl(
    config,
    candidate.itemId as string,
    candidate.mediaSourceId as string
  )
  console.log(`        url         ${redact(streamUrl)}`)

  clearTrustedMediaHosts()
  try {
    assertPlayableUrl(streamUrl)
    fail('the URL passed the player gate WITHOUT the host being trusted')
  } catch {
    pass('refused by the player gate until the host is trusted')
  }

  setTrustedMediaHosts([baseUrl])
  try {
    assertPlayableUrl(streamUrl)
    pass('accepted by the player gate once the host is configured')
  } catch (error) {
    fail('still refused after trusting the host', (error as Error).message)
  }

  // --- 6. It actually serves bytes, and serves RANGES --------------------
  // Range support is not optional: StreamCache seeks by byte range, and a
  // server that ignores Range would break every seek and every resume.
  try {
    const res = await fetch(streamUrl, { headers: { Range: 'bytes=0-65535' } })
    if (res.status === 206) {
      const buf = Buffer.from(await res.arrayBuffer())
      pass(`served a 206 partial response — ${buf.length} bytes, seeking will work`)
      console.log(`        content-range ${res.headers.get('content-range')}`)
    } else if (res.ok) {
      fail(`served HTTP ${res.status} but not 206 — Range was ignored, seeking would break`)
    } else {
      fail(`byte request rejected (HTTP ${res.status})`)
    }
  } catch (error) {
    fail('could not fetch bytes from the stream URL', (error as Error).message)
  }

  clearTrustedMediaHosts()
  console.log(
    failures === 0 ? '\n  All live checks passed.\n' : `\n  ${failures} check(s) failed.\n`
  )
  if (failures > 0) process.exitCode = 1
}

void main()
