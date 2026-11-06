// Fetches the bundled mpv build into resources/mpv-win/ (gitignored).
//
// Why this isn't committed like resources/ffmpeg-win is: shinchiro's mpv is a
// statically linked single binary of ~114MB, which is over GitHub's 100MB hard
// per-file limit. ffmpeg-win gets away with being committed only because its
// 137MB is spread across DLLs whose largest is 67MB. Git LFS was the obvious
// alternative and was rejected: GitHub's free tier allows 1GB/month of LFS
// bandwidth, and a 114MB pull on every CI run exhausts that in about nine
// builds. Fetching on postinstall also makes an mpv upgrade a two-line change
// here rather than another 30MB blob in git history forever.
//
// The release is pinned by tag AND sha256. An unpinned "latest" would let an
// upstream retag silently change what ships to users, and these binaries are
// spawned as a subprocess with a media URL — see mpv.ts's own header on why
// that process is a security boundary. A hash mismatch is a hard failure, never
// a warning.
//
// Mirror: shinchiro deletes old builds after a few weeks, and a pin that 404s
// breaks every release build. So each pinned archive is also kept as an asset
// on this repository's `mpv-mirror` release (a prerelease whose tag is not a
// version, so neither updater can take it for an app release). That copy is
// tried first, then upstream. The hash is the only trust anchor: whichever
// source answers is checked against the same MPV_SHA256. To move the pin, run
// the "mpv re-pin" workflow (.github/workflows/mpv-repin.yml). It mirrors the
// new archive and opens a PR that rewrites the three constants below by
// pattern, so keep each of them on one line as written.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'resources', 'mpv-win')

/** Bump these three together when upgrading mpv. */
const MPV_RELEASE_TAG = '20261101'
const MPV_ASSET = 'mpv-x86_64-20261101-git-48fca90e8c.7z'
const MPV_SHA256 = '7a887a10b74c1a4a7e8c29ead8300cfc610c466c4686bf9dcb92ca2f224ba110'

/** This repository's release that holds every pinned archive. Old assets are
 *  never deleted, so an older commit still builds. */
const MPV_MIRROR_TAG = 'mpv-mirror'

/** Tried in order; the first one whose bytes match MPV_SHA256 wins. */
const MPV_SOURCES = [
  {
    name: 'mirror',
    url: `https://github.com/r3v07v3r/r3v07v3r-media-hub/releases/download/${MPV_MIRROR_TAG}/${MPV_ASSET}`
  },
  {
    name: 'upstream',
    url: `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${MPV_RELEASE_TAG}/${MPV_ASSET}`
  }
]

/** Per source, so a stalled mirror falls through to upstream. */
const DOWNLOAD_TIMEOUT_MS = 120_000

// The x86_64 baseline build, deliberately not the `-v3` variant: v3 requires
// AVX2 and would simply not start on pre-Haswell CPUs.
//
// Only these two files are kept out of the archive. The rest (doc/, installer/,
// mpv/, mpv.com, and the register/unregister/updater .bat files) are for a
// standalone desktop install and have no meaning inside this app.
// d3dcompiler_43.dll is kept because mpv's d3d11 path needs it on machines
// without the DirectX redistributable present.
const KEEP_FILES = ['mpv.exe', 'd3dcompiler_43.dll']

/** Written next to the binaries so a later run can tell whether what's on disk
 *  is already the pinned build, without re-hashing a 114MB file every install. */
const STAMP_FILE = '.mpv-version.json'

function log(message: string): void {
  console.log(`[fetch-mpv] ${message}`)
}

function isUpToDate(): boolean {
  const stampPath = path.join(DEST, STAMP_FILE)
  if (!existsSync(stampPath)) return false
  if (!KEEP_FILES.every((name) => existsSync(path.join(DEST, name)))) return false
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as { sha256?: string }
    return stamp.sha256 === MPV_SHA256
  } catch {
    return false
  }
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()))
}

async function main(): Promise<void> {
  // Windows-only by design (see the plan: resources/ only ever shipped
  // ffmpeg-win, so compatibility mode never worked on mac/linux anyway).
  // A no-op rather than a failure so `npm install` still succeeds for anyone
  // developing the non-playback parts of the app on another platform.
  if (os.platform() !== 'win32') {
    log(`skipping on ${os.platform()} — the bundled player is Windows-only`)
    return
  }

  if (isUpToDate()) {
    log(`already at ${MPV_ASSET}`)
    return
  }

  const work = path.join(os.tmpdir(), `r3-mpv-fetch-${process.pid}`)
  mkdirSync(work, { recursive: true })
  const archive = path.join(work, MPV_ASSET)

  try {
    const failures: string[] = []
    let served: string | null = null
    for (const source of MPV_SOURCES) {
      try {
        log(`downloading ${MPV_ASSET} (~32MB) from the ${source.name}: ${source.url}`)
        await download(source.url, archive)
        const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
        if (actual !== MPV_SHA256) {
          throw new Error(`sha256 mismatch, expected ${MPV_SHA256}, got ${actual}`)
        }
        served = source.name
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`  ${source.name}: ${message}`)
        log(`the ${source.name} failed (${message})`)
        rmSync(archive, { force: true })
      }
    }
    if (served === null) {
      throw new Error(
        `could not fetch ${MPV_ASSET} from any source:\n${failures.join('\n')}\n` +
          'Refusing to go on without the pinned archive. If upstream deleted the build and the ' +
          'mirror does not have it, run the "mpv re-pin" workflow to move the pin to a current build.'
      )
    }
    log(`sha256 verified, served by the ${served}`)

    // bsdtar, shipped in Windows since 10 1803, reads 7z via libarchive — so
    // this needs no 7-Zip install on either a dev machine or a CI runner.
    const unpacked = path.join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    execFileSync('tar.exe', ['-xf', archive, '-C', unpacked], { stdio: 'inherit' })

    mkdirSync(DEST, { recursive: true })
    for (const name of KEEP_FILES) {
      const from = path.join(unpacked, name)
      if (!existsSync(from)) throw new Error(`${name} missing from ${MPV_ASSET}`)
      copyFileSync(from, path.join(DEST, name))
    }
    writeFileSync(
      path.join(DEST, STAMP_FILE),
      `${JSON.stringify({ tag: MPV_RELEASE_TAG, asset: MPV_ASSET, sha256: MPV_SHA256 }, null, 2)}\n`
    )

    log(`installed ${KEEP_FILES.join(', ')} into resources/mpv-win`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[fetch-mpv] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
