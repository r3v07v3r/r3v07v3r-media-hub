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

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'resources', 'mpv-win')

/** Bump these three together when upgrading mpv. */
const MPV_RELEASE_TAG = '20260814'
const MPV_ASSET = 'mpv-x86_64-20260814-git-7b8915bc1d.7z'
const MPV_SHA256 = '1bf3b029da2c98e605e00e85f21ee3142f22a1dcc4ceb5c827b5c51e36e390f9'

const MPV_URL = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${MPV_RELEASE_TAG}/${MPV_ASSET}`

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
  const response = await fetch(url, { redirect: 'follow' })
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
    log(`downloading ${MPV_ASSET} (~32MB)`)
    await download(MPV_URL, archive)

    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (actual !== MPV_SHA256) {
      throw new Error(
        `sha256 mismatch for ${MPV_ASSET}\n  expected ${MPV_SHA256}\n  actual   ${actual}\n` +
          'Refusing to use this archive. If mpv was upgraded upstream, update the pinned ' +
          'tag/asset/hash at the top of scripts/fetch-mpv.ts deliberately.'
      )
    }
    log('sha256 verified')

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
