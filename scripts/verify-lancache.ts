/**
 * Live verification of the r3-cache daemon path — the counterpart of
 * verify-jellyfin.ts for tier 2. Everything unit-testable is already
 * covered; this proves the parts that need a real daemon on a real LAN:
 * mDNS discovery crossing actual network hardware, pairing, and byte
 * serving with Range.
 *
 *   LANCACHE_URL=http://192.168.88.237:8945 \
 *   npx tsx scripts/verify-lancache.ts
 *
 * THERE IS NO PAIRING CODE ANY MORE. It was removed once devices gained
 * an approval flow: this asks to join under its own name and then waits,
 * and somebody approves "verify-lancache harness" in the app's Caching
 * page while it waits. LANCACHE_TOKEN reuses an already-approved pairing
 * and skips the wait. Neither the token nor anything derived from it is
 * ever printed.
 *
 * The byte-serving checks need one item in the cache that this device is
 * entitled to, and there is no API that puts arbitrary content there —
 * items arrive by being fetched. Place it by hand on the daemon host if
 * you want those checks; the script prints exactly what, and skips them
 * plainly rather than failing when it is absent.
 */

import { assertPlayableUrl } from '../src/main/media-hub/mpv'
import { clearTrustedMediaHosts, setTrustedMediaHosts } from '../src/main/media-hub/playback'
import { discoverLanCaches } from '../src/main/media-hub/lanCacheDiscovery'

const baseUrl = (process.env.LANCACHE_URL ?? '').replace(/\/+$/, '')
let token = process.env.LANCACHE_TOKEN ?? ''

/** The content key of the optional hand-placed fixture. */
const SEED_KEY = 'tt-seed::'

let failures = 0
let skipped = 0
const pass = (message: string): void => console.log(`  ok    ${message}`)
const fail = (message: string, detail?: unknown): void => {
  failures += 1
  console.log(`  FAIL  ${message}`)
  if (detail !== undefined) console.log(`        ${String(detail)}`)
}
/** Not a pass. Counted separately and named in the summary, because a
 *  check that did not run must never read as one that succeeded. */
const skip = (message: string): void => {
  skipped += 1
  console.log(`  skip  ${message}`)
}

async function main(): Promise<void> {
  console.log('\nr3-cache live verification\n')
  if (!baseUrl) {
    console.log('  Set LANCACHE_URL (and optionally LANCACHE_TOKEN).\n')
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
  const unauth = await fetch(`${baseUrl}/api/catalog?keys=${encodeURIComponent(SEED_KEY)}`)
  if (unauth.status === 401) pass('catalog refuses the unpaired')
  else fail(`catalog answered ${unauth.status} without a token`)

  // --- 4. pairing, and being let in --------------------------------------
  //
  // Asking to join no longer grants anything. The token comes back
  // immediately and authorises nothing until an administrator approves
  // this device, so the wait below is the flow working, not a hang.
  if (!token) {
    const paired = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName: 'verify-lancache harness' })
    })
    if (paired.status !== 200) {
      fail(`pairing refused (${paired.status}) — throttled, or too many devices waiting`)
      process.exitCode = 1
      return
    }
    const result = (await paired.json()) as { token: string; status: string }
    token = result.token
    if (result.status === 'approved') {
      // Either the server is unclaimed, or its administrator has turned
      // on "anyone on this network may join".
      pass('joined without waiting — this server is unclaimed or open')
    } else {
      console.log('\n  Waiting for approval. In the app, open Control Centre → Caching and')
      console.log('  approve "verify-lancache harness". Two minutes, then this gives up.\n')
      const deadline = Date.now() + 120_000
      let approved = false
      while (Date.now() < deadline && !approved) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const status = (await (
          await fetch(`${baseUrl}/api/pair/status`, {
            headers: { Authorization: `Bearer ${token}` }
          })
        ).json()) as { status?: string }
        approved = status.status === 'approved'
      }
      if (!approved) {
        fail('never approved — nobody said yes within two minutes')
        process.exitCode = 1
        return
      }
      pass('approved by the administrator')
    }
  }
  const auth = { Authorization: `Bearer ${token}` }

  // --- 5. catalog + the optional fixture ----------------------------------
  //
  // ?keys is required now: the unfiltered branch that returned every
  // item to any paired device was the read-side hole entitlement closed.
  const catalog = (await (
    await fetch(`${baseUrl}/api/catalog?keys=${encodeURIComponent(SEED_KEY)}`, { headers: auth })
  ).json()) as {
    items: Array<{ contentKey: string; infoHash: string; complete: boolean }>
  }
  const seeded = catalog.items.find((item) => item.contentKey === SEED_KEY)
  if (!seeded?.complete) {
    // Absent, incomplete, or present but belonging to somebody else —
    // and from here those look the same on purpose. Not a failure: the
    // fixture is optional, and saying so beats a red run that means
    // "you did not place a file".
    skip('no fixture visible to this device — the byte-serving checks below need one')
    console.log(`
        To enable them, on the daemon host create
          <dataDir>/items/<40-hex-infohash>/movie.mkv   (content starting SEEDED-LANCACHE-CONTENT-)
          <dataDir>/items/<40-hex-infohash>/meta.json
        where meta.json is
          {"contentKey":"${SEED_KEY}","title":"seed","infoHash":"<same 40 hex>",
           "fileName":"movie.mkv","sizeBytes":<bytes>,"fetchedAt":0,"lastAccessAt":0,
           "visibility":"shared"}
        and restart the daemon. "shared" is what makes it visible to this
        harness rather than to one device.
`)
    console.log(
      failures === 0
        ? `  ${skipped} skipped, nothing failed.\n`
        : `  ${failures} failed, ${skipped} skipped.\n`
    )
    if (failures > 0) process.exitCode = 1
    return
  }
  pass('the fixture is listed, complete, and entitled to this device')

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

  console.log(
    failures === 0
      ? `\n  All live checks passed${skipped ? `, ${skipped} skipped` : ''}.\n`
      : `\n  ${failures} failed${skipped ? `, ${skipped} skipped` : ''}.\n`
  )
  if (failures > 0) process.exitCode = 1
}

void main()
