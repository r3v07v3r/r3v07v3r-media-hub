// Fetches the Anime4K shader pack on demand into userData/anime4k.
//
// Not bundled, by choice: it is an optional extra for one kind of content, and
// keeping it out of the installer keeps the installer honest about what it
// ships. The trade is that this is a runtime download, so it gets the same
// posture as scripts/fetch-mpv.ts gives the player binary — pinned by release
// tag AND sha256, and a hash mismatch is a hard failure, never a warning.
// These files are handed to mpv, which compiles them on the GPU; an unpinned
// "latest" would let an upstream retag silently change what runs there.
//
// The archive is under a megabyte, so it is read into memory whole and
// unpacked with the zip primitives the subtitle and Letterboxd imports already
// use. Only the files the shipped modes reference are written out (ten of the
// thirty-nine in the zip); nothing else from the archive touches the disk.

import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  ANIME4K_REQUIRED_FILES,
  anime4kShaderChain,
  type Anime4kMode,
  type Anime4kStatus
} from '../../shared/media-hub/anime4k'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import { extractAnime4kShaders } from './anime4kArchive'
import { setAnime4kInstalledProbe } from './preferences'

/** Bump these three together when upgrading. The asset name has not tracked
 *  the tag upstream (v4.0.1 ships Anime4K_v4.0.zip), so it is pinned
 *  separately rather than derived. */
export const ANIME4K_RELEASE_TAG = 'v4.0.1'
export const ANIME4K_ASSET = 'Anime4K_v4.0.zip'
export const ANIME4K_SHA256 = '139cd282086457c5adc79caf7b75b8b825091d71c9b54958c18745fea62d7ed7'
/** Shown in Settings so the person knows what a click downloads. */
export const ANIME4K_ASSET_BYTES = 776303

const ANIME4K_URL = `https://github.com/bloc97/Anime4K/releases/download/${ANIME4K_RELEASE_TAG}/${ANIME4K_ASSET}`

/** The archive is ~0.75MB. Anything past this is not the pinned file, and
 *  the hash check would reject it anyway — this just refuses to buffer it. */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024

const STAMP_FILE = '.anime4k-version.json'

export function anime4kDir(): string {
  return path.join(app.getPath('userData'), 'anime4k')
}

/**
 * Installed means THIS pinned build, not any old files under the directory —
 * an upgrade of the pin above makes the Settings row offer the install again,
 * the same way fetch-mpv's stamp does for the player.
 */
export function isAnime4kInstalled(): boolean {
  const dir = anime4kDir()
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, STAMP_FILE), 'utf8')) as {
      sha256?: string
    }
    if (stamp.sha256 !== ANIME4K_SHA256) return false
  } catch {
    return false
  }
  return ANIME4K_REQUIRED_FILES.every((name) => fs.existsSync(path.join(dir, name)))
}

// preferences.ts reads installed-ness through this rather than importing
// here — see setAnime4kInstalledProbe.
setAnime4kInstalledProbe(() => isAnime4kInstalled())

/** Absolute paths for a mode's chain, in order. Only meaningful when
 *  isAnime4kInstalled() — the caller checks, so a missing file is never
 *  handed to mpv as a path. */
export function anime4kShaderPaths(mode: Anime4kMode): string[] {
  const dir = anime4kDir()
  return anime4kShaderChain(mode).map((name) => path.join(dir, name))
}

let installing = false

function pushStatus(status: Anime4kStatus): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.anime4kStatus, status)
}

export function anime4kStatus(): Anime4kStatus {
  if (installing) return { state: 'installing' }
  return { state: isAnime4kInstalled() ? 'installed' : 'not-installed' }
}

/**
 * Downloads, verifies, and unpacks the pinned release. Resolves to the final
 * status rather than throwing: the Settings row renders the same shape
 * whether it arrived by push or by return.
 *
 * Written into a fresh temp directory beside the target and renamed into
 * place, so a failure partway never leaves a half-installed pack that
 * isAnime4kInstalled() could mistake for a whole one (the stamp is written
 * last, and only into the temp dir).
 */
export async function installAnime4k(): Promise<Anime4kStatus> {
  if (installing) return { state: 'installing' }
  if (isAnime4kInstalled()) return { state: 'installed' }
  installing = true
  pushStatus({ state: 'installing' })
  const dir = anime4kDir()
  const temp = `${dir}.installing-${process.pid}`
  try {
    const response = await fetch(ANIME4K_URL, { redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`GET ${ANIME4K_ASSET} failed: ${response.status} ${response.statusText}`)
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_ARCHIVE_BYTES) throw new Error('Download is larger than expected.')
    const archive = Buffer.from(await response.arrayBuffer())
    if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Download is larger than expected.')

    const actual = createHash('sha256').update(archive).digest('hex')
    if (actual !== ANIME4K_SHA256) {
      throw new Error(
        `sha256 mismatch for ${ANIME4K_ASSET} (expected ${ANIME4K_SHA256}, got ${actual}). Refusing to install it.`
      )
    }

    const shaders = extractAnime4kShaders(archive)
    fs.rmSync(temp, { recursive: true, force: true })
    fs.mkdirSync(temp, { recursive: true })
    for (const [name, body] of shaders) fs.writeFileSync(path.join(temp, name), body)
    fs.writeFileSync(
      path.join(temp, STAMP_FILE),
      `${JSON.stringify({ tag: ANIME4K_RELEASE_TAG, asset: ANIME4K_ASSET, sha256: ANIME4K_SHA256 }, null, 2)}\n`
    )
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(temp, dir)

    const status: Anime4kStatus = { state: 'installed' }
    installing = false
    pushStatus(status)
    return status
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true })
    logError('anime4k:install', error)
    const status: Anime4kStatus = {
      state: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
    installing = false
    pushStatus(status)
    return status
  }
}

/** Deletes the pack. The caller clears the enabled flag alongside, so the
 *  player never references files that are gone. */
export function removeAnime4k(): Anime4kStatus {
  fs.rmSync(anime4kDir(), { recursive: true, force: true })
  const status: Anime4kStatus = { state: 'not-installed' }
  pushStatus(status)
  return status
}
