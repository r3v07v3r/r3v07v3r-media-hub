// Credentials after Electron's synchronous safeStorage (deprecated in 45,
// removed in 46): one app key sealed by the async API, AES-GCM under it for
// every secret, and a one-time move of whatever the sync API wrote.
// See src/main/media-hub/secretStorage.ts.
//
// Runs against the headless electron stand-in, whose safeStorage is real
// AES-GCM under a key file of its own, so "legacy" values here are exactly
// what an older backend wrote with encryptString.
// Run with: npx tsx tests/secretStorage.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-secret-storage-'))
process.env.R3_USER_DATA = userData
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
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).stack}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const { safeStorage } = await import('../src/headless/electronShim/index')
  const secrets = await import('../src/main/media-hub/secretStorage')
  const store = await import('../src/main/media-hub/settingsStore')
  const settingsFile = path.join(userData, 'media-hub-settings.json')
  const keyFile = path.join(userData, 'media-hub-secret.key')
  /** What the synchronous API wrote, byte for byte. */
  const legacy = (value: string): string => safeStorage.encryptString(value).toString('base64')

  await check('a secret touched before the key is unsealed throws instead of guessing', () => {
    assert.throws(() => store.encrypt('tb_live_early'), /before initSecretStorage/)
    assert.throws(() => store.decrypt('k1:anything'), /before initSecretStorage/)
  })

  // An install as the synchronous API left it: tokens top-level and nested,
  // a fallback-encoded one, and strings that are not secrets at all.
  const before = {
    onboardingVersion: 2,
    torboxToken: legacy('tb_live_abc123'),
    simklAccessToken: legacy('simkl-token'),
    lanCache: { url: 'http://cache.local', name: 'Cache', token: legacy('lan-token') },
    osApiKey: 'plain:' + Buffer.from('os-key').toString('base64'),
    friendId: 'f2b9c0d1e3a4',
    partyDisplayName: 'Graham'
  }
  fs.writeFileSync(settingsFile, JSON.stringify(before))

  await check('startup creates one sealed key file', async () => {
    await secrets.initSecretStorage(userData)
    assert.equal(secrets.secretStorageAvailable(), true)
    const sealed = fs.readFileSync(keyFile, 'utf8')
    assert.ok(sealed.length > 32)
    // Sealed by the OS layer, never the raw key.
    assert.equal(Buffer.from(sealed, 'base64').subarray(0, 4).toString('latin1'), 'r3h1')
  })

  await check('legacy values still read before the migration runs', async () => {
    await secrets.openLegacySecrets([before.torboxToken])
    assert.equal(store.decrypt(before.torboxToken), 'tb_live_abc123')
  })

  await check('the migration rewrites every legacy secret and nothing else', async () => {
    await store.migrateLegacySecrets()
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    assert.match(after.torboxToken, /^k1:/)
    assert.match(after.simklAccessToken, /^k1:/)
    assert.match(after.lanCache.token, /^k1:/)
    assert.equal(after.osApiKey, before.osApiKey)
    assert.equal(after.friendId, before.friendId)
    assert.equal(after.partyDisplayName, before.partyDisplayName)
    assert.equal(after.lanCache.url, before.lanCache.url)
    assert.equal(store.decrypt(after.torboxToken), 'tb_live_abc123')
    assert.equal(store.decrypt(after.simklAccessToken), 'simkl-token')
    assert.equal(store.decrypt(after.lanCache.token), 'lan-token')
    assert.equal(store.decrypt(after.osApiKey), 'os-key')
    assert.equal(store.getTorBoxToken(), 'tb_live_abc123')
  })

  await check('a second run finds nothing to do', async () => {
    const stamp = fs.statSync(settingsFile).mtimeMs
    await store.migrateLegacySecrets()
    assert.equal(fs.statSync(settingsFile).mtimeMs, stamp)
  })

  await check('read after write, through the settings cache', () => {
    const settings = store.readSettings()
    settings.subdlApiKey = store.encrypt('subdl-key')
    store.writeSettings(settings)
    assert.equal(store.decrypt(store.readSettings().subdlApiKey), 'subdl-key')
    // Fresh IV every time: the same token never seals to the same string.
    assert.notEqual(store.encrypt('subdl-key'), store.encrypt('subdl-key'))
  })

  await check('the next launch reuses the key file and reads everything back', async () => {
    const sealedKey = fs.readFileSync(keyFile, 'utf8')
    secrets.resetSecretStorageForTests()
    await secrets.initSecretStorage(userData)
    assert.equal(fs.readFileSync(keyFile, 'utf8'), sealedKey)
    const settings = store.readSettings()
    assert.equal(store.decrypt(settings.torboxToken), 'tb_live_abc123')
    assert.equal(store.decrypt(settings.subdlApiKey), 'subdl-key')
  })

  await check('a tampered value reads as empty, not as garbage', () => {
    const sealed = store.encrypt('simkl-token')
    const raw = Buffer.from(sealed.slice(3), 'base64')
    raw[raw.length - 1] ^= 1
    assert.equal(store.decrypt('k1:' + raw.toString('base64')), '')
    assert.equal(store.decrypt('not-a-secret'), '')
  })

  await check('the key file appears whole or not at all, and only once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-key-race-'))
    const file = path.join(dir, 'media-hub-secret.key')
    const first = Buffer.from('first sealed key')
    const second = Buffer.from('second sealed key')
    assert.equal(secrets.createKeyFile(file, first), true)
    // The copy that arrives second must not replace the first one's key.
    assert.equal(secrets.createKeyFile(file, second), false)
    assert.equal(fs.readFileSync(file, 'utf8'), first.toString('base64'))
    // No half-written temporary left behind by either attempt.
    assert.deepEqual(fs.readdirSync(dir), ['media-hub-secret.key'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('an unreadable key file is set aside, never deleted, and replaced', async () => {
    fs.writeFileSync(keyFile, Buffer.from('not sealed by anything').toString('base64'))
    secrets.resetSecretStorageForTests()
    await secrets.initSecretStorage(userData)
    assert.equal(secrets.secretStorageAvailable(), true)
    const aside = fs.readdirSync(userData).filter((name) => name.includes('.unreadable-'))
    assert.equal(aside.length, 1)
    assert.equal(store.decrypt(store.encrypt('fresh')), 'fresh')
  })

  await check('service API keys in the second settings store move too', async () => {
    secrets.resetSecretStorageForTests()
    await secrets.initSecretStorage(userData)
    const ipcSettings = await import('../src/main/ipc/settings')
    const storeFile = path.join(userData, 'r3-settings.json')
    const services = JSON.parse(
      fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '{}'
    )
    services.services = {
      ...(services.services ?? {}),
      jellyfin: { baseUrl: 'http://jf.local', apiKey: 'enc:' + legacy('jf-key'), enabled: true },
      sonarr: { baseUrl: 'http://sonarr.local', apiKey: 'plain-legacy-key', enabled: true }
    }
    fs.writeFileSync(storeFile, JSON.stringify(services))
    await ipcSettings.migrateServiceApiKeys()
    const after = JSON.parse(fs.readFileSync(storeFile, 'utf8')).services
    assert.match(after.jellyfin.apiKey, /^enc:k1:/)
    assert.equal(after.sonarr.apiKey, 'plain-legacy-key')
    assert.equal(ipcSettings.getServiceConfig('jellyfin').apiKey, 'jf-key')
  })

  console.log(`\n${pass} checks passed`)
  fs.rmSync(userData, { recursive: true, force: true })
}

void main()
