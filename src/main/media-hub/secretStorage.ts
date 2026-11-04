// Where the app's credentials get their encryption, now that Electron's
// synchronous safeStorage is going away.
//
// Electron 45 deprecates safeStorage.encryptString / decryptString /
// isEncryptionAvailable and Electron 46 removes them, following Chromium's
// removal of the synchronous OSCrypt backend. Their replacements are
// promise-based. But about sixty call sites read and write secrets
// synchronously, most of them in the middle of readSettings() /
// writeSettings() edits that are synchronous for good reason (see
// settingsStore.ts's cache), and making every one of them async would touch
// most of the service layer to change nothing anybody sees.
//
// So the OS key store seals exactly one thing: a random 256-bit key, kept
// beside the settings in KEY_FILE and unsealed once at startup, with the
// async API, before any IPC handler exists. Every secret after that is
// AES-256-GCM under that key, which node:crypto does synchronously. The OS
// still holds the only way to the key, so a settings file copied off this
// machine is exactly as useless as before.
//
// Values written by the synchronous API (on Windows, base64 of DPAPI output
// carrying a "v10" prefix; under the headless shim, its "r3h1" seal) are
// still readable, because decryptStringAsync accepts what encryptString
// produced. migrateLegacySecrets() in settingsStore.ts finds them at
// startup, opens them once with the async API, and writes them back in this
// format; until that write lands, openSecret() answers for them from the
// plaintexts it opened, so a caller holding an old string still gets the
// right answer.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { electronModule } from './electronModule'
import { logError } from './logger'

/** The tag on every value sealed with the app key. */
export const SEALED_PREFIX = 'k1:'
const KEY_FILE = 'media-hub-secret.key'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * undefined: initSecretStorage() has not finished. null: it finished and
 * the OS has no key store, so secrets fall back to settingsStore.ts's
 * tagged plaintext exactly as they did before.
 */
let appKey: Buffer | null | undefined
/** Legacy ciphertext -> plaintext, filled by openLegacySecrets(). */
const legacyPlaintexts = new Map<string, string>()

export function secretStorageReady(): boolean {
  return appKey !== undefined
}

/** True once ready and the OS key store is usable. */
export function secretStorageAvailable(): boolean {
  return appKey !== undefined && appKey !== null
}

function safeStorage(): Electron.SafeStorage {
  return electronModule().safeStorage
}

/**
 * Writes the sealed key only if no file is there yet. The app takes no
 * single-instance lock: two copies starting together must not each mint a
 * key and leave the loser's secrets unreadable, so the second one to arrive
 * reads the first one's file instead.
 */
function createKeyFile(file: string, sealed: Buffer): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, sealed.toString('base64'), { mode: 0o600, flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

async function unsealKeyFile(file: string): Promise<Buffer> {
  const sealed = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
  const { result, shouldReEncrypt } = await safeStorage().decryptStringAsync(sealed)
  const key = Buffer.from(result, 'base64')
  if (key.length !== 32) throw new Error(`${KEY_FILE} does not hold a 256-bit key.`)
  if (shouldReEncrypt) {
    // The OS wants it under a newer key of its own. Best effort: the old
    // seal keeps working until it is replaced.
    try {
      const resealed = await safeStorage().encryptStringAsync(result)
      const temporary = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, resealed.toString('base64'), { mode: 0o600 })
      fs.renameSync(temporary, file)
    } catch (error) {
      logError('media-hub:secretStorage', error)
    }
  }
  return key
}

async function loadOrCreateKey(file: string): Promise<Buffer> {
  if (fs.existsSync(file)) {
    try {
      return await unsealKeyFile(file)
    } catch (error) {
      // Unreadable: another machine's file restored over this one, or a
      // reset key store. Everything sealed with it is lost either way (as
      // it was when DPAPI refused a token before this file existed), so the
      // useful thing is a working key going forward. The old file is kept
      // aside, never deleted, in case the key store comes back.
      logError('media-hub:secretStorage', error)
      fs.renameSync(file, `${file}.unreadable-${Date.now()}`)
    }
  }
  const fresh = crypto.randomBytes(32)
  const sealed = await safeStorage().encryptStringAsync(fresh.toString('base64'))
  if (createKeyFile(file, sealed)) return fresh
  return unsealKeyFile(file)
}

/**
 * Unseals (or creates) the app key. Must finish before anything encrypts or
 * decrypts a secret: both entry points await it ahead of startBackend().
 * Never throws; with no usable key store the app runs on the tagged
 * plaintext fallback, as it always has in that case.
 */
export async function initSecretStorage(userDataDir: string): Promise<void> {
  if (appKey !== undefined) return
  try {
    if (!(await safeStorage().isAsyncEncryptionAvailable())) {
      appKey = null
      return
    }
    appKey = await loadOrCreateKey(path.join(userDataDir, KEY_FILE))
  } catch (error) {
    logError('media-hub:secretStorage', error)
    appKey = null
  }
}

function assertReady(): void {
  if (appKey === undefined) {
    // A secret touched before startup unsealed the key. Failing loudly beats
    // quietly writing a token in the clear or reading it back as ''.
    throw new Error('Secret storage was used before initSecretStorage() finished.')
  }
}

/** The sealed form of `value`, or null when the OS has no key store. */
export function sealSecret(value: string): string | null {
  assertReady()
  if (!appKey) return null
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey, iv)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * The plaintext of a value from sealSecret() or of a legacy value opened at
 * startup; '' for anything else, or anything that fails to open.
 */
export function openSecret(value: string): string {
  assertReady()
  if (!value.startsWith(SEALED_PREFIX)) return legacyPlaintexts.get(value) ?? ''
  if (!appKey) return ''
  try {
    const raw = Buffer.from(value.slice(SEALED_PREFIX.length), 'base64')
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const decipher = crypto.createDecipheriv('aes-256-gcm', appKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final()
    ]).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Whether a stored string looks like the synchronous API's output: base64
 * whose bytes open with OSCrypt's version tag ("v10", "v11") or the headless
 * shim's "r3h1" seal. A false positive only costs one failed async decrypt.
 */
export function isLegacySealed(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 16 || !/^[A-Za-z0-9+/]+=*$/.test(value)) {
    return false
  }
  const head = Buffer.from(value.slice(0, 8), 'base64').subarray(0, 4).toString('latin1')
  return /^v1\d/.test(head) || head === 'r3h1'
}

/**
 * Opens legacy values with the async API and remembers their plaintexts for
 * openSecret(). Returns the ones that opened; the rest stay unreadable, as
 * they were.
 */
export async function openLegacySecrets(values: Iterable<string>): Promise<Map<string, string>> {
  const opened = new Map<string, string>()
  for (const value of new Set(values)) {
    try {
      const { result } = await safeStorage().decryptStringAsync(Buffer.from(value, 'base64'))
      opened.set(value, result)
      legacyPlaintexts.set(value, result)
    } catch {
      /* not ours, or from another machine: left as it is */
    }
  }
  return opened
}

/** Test seam: forget the key so a test can initialise against another folder. */
export function resetSecretStorageForTests(): void {
  appKey = undefined
  legacyPlaintexts.clear()
}
