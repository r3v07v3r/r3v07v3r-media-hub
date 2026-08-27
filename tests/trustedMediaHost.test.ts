import assert from 'node:assert/strict'
import {
  assertPublicMediaUrl,
  clearTrustedMediaHosts,
  isAllowedRemoteMediaUrl,
  isTrustedMediaHost,
  safeFetchMedia,
  setTrustedMediaHosts
} from '../src/main/media-hub/playback'

const JELLYFIN = 'http://192.168.1.50:8096'
const PUBLIC = 'https://cdn.example.com/movie.mkv'
const PRIVATE = 'http://192.168.1.50:8096/Videos/abc/stream?static=true'

// --- 1. An empty trusted set must reproduce the pre-exception behaviour ---
clearTrustedMediaHosts()
assert.equal(isAllowedRemoteMediaUrl(PUBLIC), true, 'public https is still allowed')
assert.equal(isAllowedRemoteMediaUrl(PRIVATE), false, 'a private address is rejected by default')
assert.equal(isAllowedRemoteMediaUrl('http://cdn.example.com/a.mkv'), false, 'plain http rejected')
assert.equal(isAllowedRemoteMediaUrl('https://localhost/a.mkv'), false, 'localhost rejected')
assert.equal(isAllowedRemoteMediaUrl('https://nas.local/a.mkv'), false, '.local rejected')
assert.equal(isAllowedRemoteMediaUrl('https://box.lan/a.mkv'), false, '.lan rejected')

// --- 2. A configured host is reachable over plain http on a private IP ---
setTrustedMediaHosts([JELLYFIN])
assert.equal(isAllowedRemoteMediaUrl(PRIVATE), true, 'the configured media server is allowed')
assert.equal(isTrustedMediaHost(new URL(PRIVATE)), true, 'host:port matches the allowlist')

// --- 3. The exception is exact: a different port on the same box is not trusted ---
assert.equal(
  isAllowedRemoteMediaUrl('http://192.168.1.50:9000/Videos/abc/stream'),
  false,
  'a different port on the same host stays blocked'
)
assert.equal(
  isAllowedRemoteMediaUrl('http://192.168.1.51:8096/Videos/abc/stream'),
  false,
  'a different host on the same LAN stays blocked'
)
assert.equal(
  isAllowedRemoteMediaUrl('http://192.168.1.50:8096@evil.example.com/x'),
  false,
  'the host is taken from the real authority, not a userinfo prefix'
)

// --- 4. Credentials are disqualifying even for a trusted host ---
assert.equal(
  isAllowedRemoteMediaUrl('http://user:pw@192.168.1.50:8096/Videos/abc'),
  false,
  'embedded credentials are rejected on the trusted path too'
)

// --- 5. Default ports normalize, so :80 and an implicit port are one entry ---
setTrustedMediaHosts(['http://media.example.com'])
assert.equal(
  isAllowedRemoteMediaUrl('http://media.example.com/Videos/x'),
  true,
  'an implicit :80 matches a base URL saved without a port'
)
assert.equal(
  isAllowedRemoteMediaUrl('http://media.example.com:8096/Videos/x'),
  false,
  'an explicit non-default port does not match the implicit-port entry'
)

// --- 6. Unticking "enabled" in Settings revokes access (set is replaced) ---
setTrustedMediaHosts([JELLYFIN])
assert.equal(isAllowedRemoteMediaUrl(PRIVATE), true, 'trusted before revocation')
setTrustedMediaHosts([])
assert.equal(isAllowedRemoteMediaUrl(PRIVATE), false, 'revoked as soon as the set is replaced')

// --- 7. Malformed saved URLs grant nothing and do not throw ---
setTrustedMediaHosts(['', 'not a url', 'ftp://192.168.1.50', 'http://u:p@192.168.1.50:8096'])
assert.equal(
  isAllowedRemoteMediaUrl(PRIVATE),
  false,
  'unparseable, non-http and credentialed entries are all dropped'
)

async function main(): Promise<void> {
  // --- 8. assertPublicMediaUrl skips the rebinding check only for trusted hosts ---
  let resolveCalls = 0
  const countingResolve = async (): Promise<string[]> => {
    resolveCalls += 1
    return ['192.168.1.50']
  }

  setTrustedMediaHosts([JELLYFIN])
  await assertPublicMediaUrl(PRIVATE, countingResolve)
  assert.equal(resolveCalls, 0, 'no DNS round-trip for a trusted host')

  clearTrustedMediaHosts()
  await assert.rejects(
    () => assertPublicMediaUrl(PRIVATE, countingResolve),
    /valid public HTTPS media URL/,
    'an untrusted private URL still fails the syntactic gate'
  )
  await assert.rejects(
    () => assertPublicMediaUrl(PUBLIC, countingResolve),
    /private network address/,
    'a public hostname resolving to a private address is still rebinding-rejected'
  )

  // --- 9. A trusted host cannot launder a redirect into another private address ---
  const redirectingFetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.startsWith(JELLYFIN)) {
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.9/secret' } })
    }
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch

  setTrustedMediaHosts([JELLYFIN])
  await assert.rejects(
    () => safeFetchMedia(PRIVATE, {}, redirectingFetch, async () => ['10.0.0.9']),
    /valid public HTTPS media URL/,
    'trust is not inherited by a redirect to a different private host'
  )

  // A redirect within the same trusted host is fine — it is the same server.
  const sameHostFetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/stream?static=true')) {
      return new Response(null, {
        status: 302,
        headers: { location: `${JELLYFIN}/Videos/abc/stream.mkv` }
      })
    }
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch

  const followed = await safeFetchMedia(PRIVATE, {}, sameHostFetch, async () => ['192.168.1.50'])
  assert.equal(followed.status, 200, 'a redirect within the trusted host is followed')

  clearTrustedMediaHosts()
}

void main().then(() => {
  console.log('ok  trusted media host exception')
})
