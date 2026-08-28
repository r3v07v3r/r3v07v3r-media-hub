/**
 * Live verification of the r3-cache daemon path — the counterpart of
 * verify-jellyfin.ts for tier 2. Everything unit-testable is already
 * covered; this proves the parts that need a real daemon on a real LAN:
 * mDNS discovery crossing actual network hardware, pairing, and byte
 * serving with Range.
 *
 *   LANCACHE_URL=http://192.168.88.237:8945 \
 *   LANCACHE_CODE=123456 \
 *   npx tsx scripts/verify-lancache.ts
 *
 * LANCACHE_CODE pairs a fresh device (consuming the code — the daemon
 * prints a new one). Alternatively LANCACHE_TOKEN reuses an existing
 * pairing. Neither is ever printed.
 */

import { assertPlayableUrl } from '../src/main/media-hub/mpv'
import { clearTrustedMediaHosts, setTrustedMediaHosts } from '../src/main/media-hub/playback'
import { discoverLanCaches } from '../src/main/media-hub/lanCacheDiscovery'

const baseUrl = (process.env.LANCACHE_URL ?? '').replace(/\/+$/, '')
const code = process.env.LANCACHE_CODE ?? ''
let token = process.env.LANCACHE_TOKEN ?? ''

let failures = 0
const pass = (message: string): void => console.log(`  ok    ${message}`)
const fail = (message: string, detail?: unknown): void => {
  failures += 1
  console.log(`  FAIL  ${message}`)
  if (detail !== undefined) console.log(`        ${String(detail)}`)
}

async function main(): Promise<void> {
  console.log('\nr3-cache live verification\n')
  if (!baseUrl) {
    console.log('  Set LANCACHE_URL (and LANCACHE_CODE or LANCACHE_TOKEN).\n')
    process.exitCode = 1
    return
  }
  console.log(`  daemon  ${baseUrl}\n`)

  // --- 1. mDNS discovery actually crosses this network -------------------
  const found = await discoverLanCaches(3000)
  const matched = found.find((daemon) => daemon.url === baseUrl)
  if (matched) pass(`discovered via mDNS as "${matched.name}" at ${matched.url}`)
  else if (found.length) fail(`mDNS found ${found.length} daemon(s), but none matching ${baseUrl}`)
  else
    console.log(
      '  note  mDNS found nothing — possible on filtered networks; manual URL still works'
    )

  // --- 2. identity -------------------------------------------------------
  try {
    const ping = (await (await fetch(`${baseUrl}/api/ping`)).json()) as {
      product?: string
      serverName?: string
      version?: string
    }
    if (ping.product === 'r3-cache') {
      pass(`identified: ${ping.serverName} v${ping.version}`)
    } else {
      fail('answered, but not as an r3-cache daemon')
      process.exitCode = 1
      return
    }
  } catch (error) {
    fail('unreachable', (error as Error).message)
    process.exitCode = 1
    return
  }

  // --- 3. auth boundary --------------------------------------------------
  const unauth = await fetch(`${baseUrl}/api/catalog`)
  if (unauth.status === 401) pass('catalog refuses the unpaired')
  else fail(`catalog answered ${unauth.status} without a token`)

  // --- 4. pairing --------------------------------------------------------
  if (!token && code) {
    const paired = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'verify-lancache harness' })
    })
    if (paired.status === 200) {
      token = ((await paired.json()) as { token: string }).token
      pass('paired with the console code (a fresh code is now on the console)')
    } else {
      fail(`pairing rejected (${paired.status}) — code wrong, expired, or throttled`)
    }
  }
  if (!token) {
    console.log('\n  No token — the authenticated checks need LANCACHE_CODE or LANCACHE_TOKEN.\n')
    process.exitCode = 1
    return
  }
  const auth = { Authorization: `Bearer ${token}` }

  // --- 5. catalog + the seeded item --------------------------------------
  const catalog = (await (await fetch(`${baseUrl}/api/catalog`, { headers: auth })).json()) as {
    items: Array<{ contentKey: string; infoHash: string; complete: boolean }>
  }
  pass(`catalog answers: ${catalog.items.length} item(s)`)
  const seeded = catalog.items.find((item) => item.contentKey === 'tt-seed::')
  if (!seeded?.complete) {
    fail('the seeded verification item is missing or incomplete')
    process.exitCode = 1
    return
  }
  pass('seeded item is listed complete')

  // --- 6. serving: token gate, Range contract, and the player's own gate --
  const streamUrl = `${baseUrl}/stream/${seeded.infoHash}?token=${encodeURIComponent(token)}`

  const noToken = await fetch(`${baseUrl}/stream/${seeded.infoHash}`)
  if (noToken.status === 403) pass('stream refuses without a token')
  else fail(`stream answered ${noToken.status} without a token`)

  const ranged = await fetch(streamUrl, { headers: { Range: 'bytes=0-99' } })
  if (ranged.status === 206) {
    const body = Buffer.from(await ranged.arrayBuffer())
    pass(`206 partial: ${body.length} bytes, content-range ${ranged.headers.get('content-range')}`)
    if (!body.toString().startsWith('SEEDED-LANCACHE-CONTENT-')) {
      fail('bytes served were not the seeded content')
    }
  } else {
    fail(`Range request got ${ranged.status}, not 206 — seeking would break`)
  }

  clearTrustedMediaHosts()
  try {
    assertPlayableUrl(streamUrl)
    fail('the stream URL passed the player gate WITHOUT the host being trusted')
  } catch {
    pass('refused by the player gate until the daemon host is trusted')
  }
  setTrustedMediaHosts([baseUrl])
  try {
    assertPlayableUrl(streamUrl)
    pass('accepted by the player gate once pairing publishes the host')
  } catch (error) {
    fail('still refused after trusting the host', (error as Error).message)
  }
  clearTrustedMediaHosts()

  console.log(failures === 0 ? '\n  All live checks passed.\n' : `\n  ${failures} failed.\n`)
  if (failures > 0) process.exitCode = 1
}

void main()
