// The Trakt and MyAnimeList account marks (settingsStore.ts) across a token
// refresh and a new sign-in.
//
// The marks stamp everything remembered about one account (WATCHLIST-SYNC.md
// rule 7). They used to be a hash of the current access token, and both
// services refresh that token silently, so every refresh read as a new
// account: owed pushes were dropped and the Trakt pull re-read the whole
// account. A refresh now keeps the mark; a sign-in, which may be somebody
// else, still gets a new one.
//
// settingsStore reaches Electron for its settings path, so the module is
// loaded with 'electron' pointed at the headless stand-in, as
// historyPendingSummary.test.ts does. Tokens are written in the store's
// "plain:" form, which decrypt reads without any key; but the refresh and
// sign-in paths seal what they store, and sealing throws until
// initSecretStorage() has unsealed the app key, as the app does at startup.
// Run with: npx tsx tests/accountMarks.test.ts

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-account-marks-'))
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

const plain = (value: string): string => `plain:${Buffer.from(value, 'utf8').toString('base64')}`

/** The mark as every version before this one computed it: stamps already on
 *  disk carry exactly this, so the first read after upgrading must match. */
const hashOf = (salt: string, token: string): string =>
  crypto.createHash('sha256').update(`${salt}:${token}`).digest('hex').slice(0, 16)

async function main(): Promise<void> {
  // The app unseals its credentials' key before anything stores a token.
  // Without it traktClient's storeTokens throws inside refreshIfDue's
  // best-effort catch and the refresh is silently dropped.
  const { initSecretStorage } = await import('../src/main/media-hub/secretStorage')
  await initSecretStorage(process.env.R3_USER_DATA as string)
  const store = await import('../src/main/media-hub/settingsStore')
  const { readSettings, writeSettings, trackingAccountMarks, traktAccountMark } = store

  // ---- Trakt ----------------------------------------------------------------

  // Signed in, never refreshed: the mark is the token's hash, as before.
  writeSettings({ traktAccessToken: plain('trakt-first') })
  const signedIn = traktAccountMark()
  assert.equal(signedIn, hashOf('trakt-account', 'trakt-first'))

  // A refresh: the token changes, the account does not, and neither does
  // the mark.
  let settings = readSettings()
  store.carryAccountMarkThroughRefresh(settings, 'trakt')
  settings.traktAccessToken = plain('trakt-refreshed')
  writeSettings(settings)
  assert.equal(traktAccountMark(), signedIn, 'a refresh keeps the Trakt mark')

  // A second refresh carries the sign-in's mark on, not the first refresh's.
  settings = readSettings()
  store.carryAccountMarkThroughRefresh(settings, 'trakt')
  settings.traktAccessToken = plain('trakt-refreshed-again')
  writeSettings(settings)
  assert.equal(traktAccountMark(), signedIn, 'every later refresh keeps it too')

  // A new sign-in, possibly somebody else: a new mark, from its own token.
  settings = readSettings()
  store.forgetAccountMark(settings, 'trakt')
  settings.traktAccessToken = plain('trakt-other-account')
  writeSettings(settings)
  assert.equal(traktAccountMark(), hashOf('trakt-account', 'trakt-other-account'))
  assert.notEqual(traktAccountMark(), signedIn, 'a sign-in changes the Trakt mark')

  // Signed out: no mark at all, whatever was pinned.
  settings = readSettings()
  store.carryAccountMarkThroughRefresh(settings, 'trakt')
  settings.traktAccessToken = undefined
  writeSettings(settings)
  assert.equal(traktAccountMark(), '', 'nothing connected matches no stamp')

  // ---- MyAnimeList ----------------------------------------------------------

  writeSettings({ malAccessToken: plain('mal-first') })
  const malSignedIn = trackingAccountMarks().mal
  assert.equal(malSignedIn, hashOf('mal-account', 'mal-first'))

  settings = readSettings()
  store.carryAccountMarkThroughRefresh(settings, 'mal')
  settings.malAccessToken = plain('mal-refreshed')
  writeSettings(settings)
  assert.equal(trackingAccountMarks().mal, malSignedIn, 'a refresh keeps the MAL mark')

  settings = readSettings()
  store.forgetAccountMark(settings, 'mal')
  settings.malAccessToken = plain('mal-other-account')
  writeSettings(settings)
  assert.equal(trackingAccountMarks().mal, hashOf('mal-account', 'mal-other-account'))
  assert.notEqual(trackingAccountMarks().mal, malSignedIn, 'a sign-in changes the MAL mark')

  // The two services never share a pinned mark.
  writeSettings({ traktAccessToken: plain('same'), malAccessToken: plain('same') })
  settings = readSettings()
  store.carryAccountMarkThroughRefresh(settings, 'trakt')
  store.carryAccountMarkThroughRefresh(settings, 'mal')
  writeSettings(settings)
  const marks = trackingAccountMarks()
  assert.notEqual(marks.trakt, marks.mal)

  await realPaths(store)

  console.log('account mark tests passed')
}

/**
 * The same, through the code that refreshes, signs in and signs out, with
 * both services faked at fetch: the helpers above are only as good as the
 * places that call them.
 */
async function realPaths(
  store: typeof import('../src/main/media-hub/settingsStore')
): Promise<void> {
  const { readSettings, writeSettings, trackingAccountMarks, traktAccountMark } = store
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const trakt = await import('../src/main/media-hub/traktClient')
  const mal = await import('../src/main/media-hub/malSync')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')
  setDatabase(createDatabase(path.join(process.env.R3_USER_DATA!, 'marks.sqlite'), 'profile-m'))
  trakt.registerTraktIpc()
  mal.registerMalIpc()
  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (channel: string): Promise<unknown> =>
    ipcMain.dispatchInvoke(event, channel, [undefined])

  const DAY = 24 * 60 * 60 * 1000
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
  const tokens = (access: string, refresh: string): Record<string, unknown> => ({
    access_token: access,
    refresh_token: refresh,
    created_at: Math.floor(Date.now() / 1000),
    expires_in: 90 * 24 * 60 * 60
  })
  /** Run once while the next token refresh is out, before it answers. */
  let whileRefreshing: (() => Promise<unknown>) | null = null
  const refreshing = async (): Promise<void> => {
    const during = whileRefreshing
    whileRefreshing = null
    await during?.()
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    switch (`${url.host}${url.pathname}`) {
      case 'api.trakt.tv/oauth/token':
        await refreshing()
        return json(tokens('trakt-refreshed', 'trakt-r2'))
      case 'api.trakt.tv/oauth/device/code':
        return json({ device_code: 'device', user_code: 'CODE', interval: 5, expires_in: 600 })
      case 'api.trakt.tv/oauth/device/token':
        return json(tokens('trakt-signed-in', 'trakt-r3'))
      case 'myanimelist.net/v1/oauth2/token':
        await refreshing()
        return json(tokens('mal-refreshed', 'mal-r2'))
      default:
        return json({})
    }
  }) as typeof fetch

  // Trakt: a request with the token within its refresh window refreshes it,
  // and the mark stays the one the account was signed in with.
  writeSettings({
    traktClientId: 'tid',
    traktClientSecret: plain('secret'),
    traktAccessToken: plain('trakt-old'),
    traktRefreshToken: plain('trakt-r1'),
    traktExpiresAt: Date.now() + DAY
  })
  const traktBefore = traktAccountMark()
  await trakt.traktRequest('/sync/last_activities')
  assert.equal(store.traktCredentials().accessToken, 'trakt-refreshed', 'the token was refreshed')
  assert.equal(traktAccountMark(), traktBefore, "Trakt's refresh keeps the mark")

  // A device-code sign-in may be somebody else: the mark is its own token's.
  await invoke(MEDIA_HUB_CHANNELS.traktStart)
  assert.deepEqual(await invoke(MEDIA_HUB_CHANNELS.traktPoll), { state: 'connected' })
  assert.equal(traktAccountMark(), hashOf('trakt-account', 'trakt-signed-in'))
  // Refreshed in turn, which pins that mark, then signed out: nothing
  // pinned is left for the next account.
  const settings = readSettings()
  settings.traktExpiresAt = Date.now() + DAY
  writeSettings(settings)
  await trakt.traktRequest('/sync/last_activities')
  assert.equal(readSettings().traktAccountMark, hashOf('trakt-account', 'trakt-signed-in'))
  await invoke(MEDIA_HUB_CHANNELS.traktDisconnect)
  assert.equal(traktAccountMark(), '')
  assert.equal(readSettings().traktAccountMark, undefined)

  // A sign-in that lands while a refresh is out: the refresh's answer is for
  // the connection that is gone, so it is dropped, not written over the new
  // one with the new one's mark pinned on it; and the request that waited on
  // it fails rather than go to the account signed in now.
  await invoke(MEDIA_HUB_CHANNELS.traktStart)
  writeSettings({
    ...readSettings(),
    traktAccessToken: plain('trakt-old'),
    traktRefreshToken: plain('trakt-r1'),
    traktExpiresAt: Date.now() + DAY
  })
  whileRefreshing = () => invoke(MEDIA_HUB_CHANNELS.traktPoll)
  await assert.rejects(trakt.traktRequest('/sync/last_activities'), /signed in or out/)
  assert.equal(
    store.traktCredentials().accessToken,
    'trakt-signed-in',
    "a refresh that was out during a sign-in does not overwrite the new account's token"
  )
  assert.equal(traktAccountMark(), hashOf('trakt-account', 'trakt-signed-in'))
  assert.equal(readSettings().traktAccountMark, undefined)

  // Another refresh of the same account landing first is not that: this one
  // is written as before, the mark stays, and the request goes ahead.
  writeSettings({ ...readSettings(), traktExpiresAt: Date.now() + DAY })
  const sameAccount = traktAccountMark()
  whileRefreshing = async () => {
    const elsewhere = readSettings()
    store.carryAccountMarkThroughRefresh(elsewhere, 'trakt')
    elsewhere.traktAccessToken = plain('trakt-refreshed-elsewhere')
    elsewhere.traktRefreshToken = plain('trakt-r9')
    writeSettings(elsewhere)
  }
  await trakt.traktRequest('/sync/last_activities')
  assert.equal(store.traktCredentials().accessToken, 'trakt-refreshed')
  assert.equal(traktAccountMark(), sameAccount)

  // MyAnimeList: a request with the token about to expire refreshes it, and
  // the mark stays.
  writeSettings({
    malClientId: 'mid',
    malAccessToken: plain('mal-old'),
    malRefreshToken: plain('mal-r1'),
    malTokenExpiresAt: Date.now() - 1000
  })
  const malBefore = trackingAccountMarks().mal
  await mal.malRequest('/users/@me')
  assert.equal(store.malCredentials().accessToken, 'mal-refreshed', 'the token was refreshed')
  assert.equal(trackingAccountMarks().mal, malBefore, "MyAnimeList's refresh keeps the mark")
  await invoke(MEDIA_HUB_CHANNELS.malDisconnect)
  assert.equal(trackingAccountMarks().mal, '')
  assert.equal(readSettings().malAccountMark, undefined)

  // Disconnected while a refresh was out: the refresh does not connect it
  // again behind the person's back, and the request that waited fails.
  writeSettings({
    malClientId: 'mid',
    malAccessToken: plain('mal-old'),
    malRefreshToken: plain('mal-r1'),
    malTokenExpiresAt: Date.now() - 1000
  })
  whileRefreshing = () => invoke(MEDIA_HUB_CHANNELS.malDisconnect)
  await assert.rejects(mal.malRequest('/users/@me'), /signed in or out/)
  assert.equal(store.malCredentials().accessToken, '', 'still disconnected')
  assert.equal(trackingAccountMarks().mal, '')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
