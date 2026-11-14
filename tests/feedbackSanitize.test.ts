// What a tester's report is cleaned of before it leaves their machine (and
// again at the Worker). See src/shared/feedback/sanitize.ts.
// Run with: npx tsx tests/feedbackSanitize.test.ts

import assert from 'node:assert/strict'
import { sanitizeText, sanitizeValue } from '../src/shared/feedback/sanitize'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

check('a Windows user folder keeps what comes after the account name', () => {
  assert.equal(
    sanitizeText('C:\\Users\\SamJones\\AppData\\Roaming\\r3v07v3r-media-hub\\logs\\media-hub.log'),
    '%USERPROFILE%\\AppData\\Roaming\\r3v07v3r-media-hub\\logs\\media-hub.log'
  )
})

check('doubled backslashes, forward slashes and lower case', () => {
  assert.equal(sanitizeText('"C:\\\\Users\\\\Sam\\\\Videos"'), '"%USERPROFILE%\\\\Videos"')
  assert.equal(
    sanitizeText('at c:/users/sam/app/out/main.js:10'),
    'at %USERPROFILE%/app/out/main.js:10'
  )
})

check('file URLs in stack frames become cleaned paths', () => {
  assert.equal(
    sanitizeText(
      'at file:///C:/Users/Sam/AppData/Local/Programs/app/resources/app.asar/out/main/index.js:5:3'
    ),
    'at %USERPROFILE%/AppData/Local/Programs/app/resources/app.asar/out/main/index.js:5:3'
  )
})

check('macOS and Linux home folders', () => {
  assert.equal(sanitizeText('open /Users/sam/Library/Logs/x'), 'open ~/Library/Logs/x')
  assert.equal(sanitizeText('read /home/sam/.config/app'), 'read ~/.config/app')
})

check('the account and computer names are blanked wherever else they appear', () => {
  assert.equal(
    sanitizeText('profile SamJones on DESKTOP-7Q2 failed', {
      names: { user: ['SamJones'], computer: ['DESKTOP-7Q2'] }
    }),
    'profile <user> on <computer> failed'
  )
})

check("a computer named after the app does not blank the app's own folder", () => {
  assert.equal(
    sanitizeText('D:\\Git-Repos\\r3v07v3r-media-hub\\out on R3v07v3R', {
      names: { computer: ['R3v07v3R'] }
    }),
    'D:\\Git-Repos\\r3v07v3r-media-hub\\out on <computer>'
  )
})

check('network shares lose the server name', () => {
  assert.equal(sanitizeText('\\\\NAS-01\\Media\\Films'), '\\\\<server>\\Media\\Films')
})

check('known service URLs keep only their host; others are dropped', () => {
  assert.equal(
    sanitizeText('GET https://api.torbox.app/v1/api/torrents/requestdl?token=abc&id=5 failed'),
    'GET https://api.torbox.app/… failed'
  )
  assert.equal(sanitizeText('relay wss://r3-party-sync.someone.workers.dev/party/x'), 'relay [url]')
  assert.equal(sanitizeText('jellyfin http://192.168.1.20:8096/Items'), 'jellyfin [url]')
  assert.equal(sanitizeText('https://user:pw@api.simkl.com/sync'), 'https://api.simkl.com/…')
})

check('addresses: IPv4, IPv6 and MAC; loopback and times kept', () => {
  assert.equal(sanitizeText('connect 10.0.0.7 and 127.0.0.1'), 'connect [ip] and 127.0.0.1')
  assert.equal(sanitizeText('fe80:0:0:0:1ff:fe23:4567:890a up'), '[ip] up')
  assert.equal(sanitizeText('adapter 00:1A:2B:3C:4D:5E'), 'adapter [mac]')
  assert.equal(sanitizeText('at 12:30:45 build 1.0.83'), 'at 12:30:45 build 1.0.83')
})

check('emails, bearer tokens, key=value secrets and JWTs', () => {
  assert.equal(sanitizeText('mail sam@example.com'), 'mail [email]')
  assert.equal(sanitizeText('Authorization: Bearer abc.def-123'), 'Authorization: [secret]')
  assert.equal(sanitizeText('Bearer abcdef123'), 'Bearer [secret]')
  assert.equal(
    sanitizeText('api_key=XYZ123 password: hunter2'),
    'api_key=[secret] password: [secret]'
  )
  assert.equal(sanitizeText('{"access_token":"tok123"}'), '{"access_token":"[secret]"}')
  assert.equal(
    sanitizeText(
      'got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    ),
    'got [secret]'
  )
})

check('info-hashes, long keys and magnets', () => {
  assert.equal(sanitizeText('hash 0123456789abcdef0123456789abcdef01234567'), 'hash [hex]')
  assert.equal(sanitizeText('key a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7'), 'key [secret]')
  assert.equal(sanitizeText('magnet:?xt=urn:btih:abc&tr=udp://t'), '[magnet]')
})

check('ordinary error text survives untouched', () => {
  const line =
    "TypeError: Cannot read properties of undefined (reading 'season') at playEpisode (playback.ts:412:9)"
  assert.equal(sanitizeText(line), line)
  assert.equal(
    sanitizeText('Player command timed out: get_property time-pos'),
    'Player command timed out: get_property time-pos'
  )
  assert.equal(sanitizeText('HTTP 503 error code: 1015'), 'HTTP 503 error code: 1015')
})

check('length cap', () => {
  assert.equal(sanitizeText('abcdefghij', { maxLength: 4 }), 'abcd… [cut 6 chars]')
})

check('sanitizeValue cleans nested strings and keys', () => {
  assert.deepEqual(
    sanitizeValue({ path: 'C:\\Users\\Sam\\x', n: 3, ok: true, list: ['10.1.1.1'] }),
    { path: '%USERPROFILE%\\x', n: 3, ok: true, list: ['[ip]'] }
  )
})

check('never throws on odd input', () => {
  assert.equal(sanitizeText(undefined), '')
  assert.equal(sanitizeText(42), '42')
  const bad = {
    toString: () => {
      throw new Error('x')
    }
  }
  assert.equal(sanitizeText(bad), '')
})

console.log(`\n${pass} passed`)
