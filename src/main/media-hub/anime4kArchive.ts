// The pure half of the Anime4K installer: which files come out of the
// upstream archive. Kept apart from anime4kInstall.ts because that module
// imports `electron` for the userData path, and the test runner has no
// Electron — the same reason zipArchive.ts is its own module.

import path from 'node:path'

import { ANIME4K_REQUIRED_FILES } from '../../shared/media-hub/anime4k'
import { inflateZipEntry, readZipCentralDirectory } from './zipArchive'

/** Largest shader in the pack is ~310KB. */
const MAX_SHADER_BYTES = 2 * 1024 * 1024

/**
 * Picks the required shaders out of the archive. Pure, so the test can feed
 * it an in-memory zip. Throws if any required file is absent: a pack missing
 * one shader would make some modes silently fail in mpv later, which is worse
 * than refusing the install now.
 */
export function extractAnime4kShaders(archive: Buffer): Map<string, Buffer> {
  const entries = readZipCentralDirectory(archive)
  const byName = new Map(entries.map((entry) => [path.posix.basename(entry.fileName), entry]))
  const out = new Map<string, Buffer>()
  for (const name of ANIME4K_REQUIRED_FILES) {
    const entry = byName.get(name)
    if (!entry) throw new Error(`${name} is missing from the Anime4K archive`)
    out.set(name, inflateZipEntry(archive, entry, MAX_SHADER_BYTES))
  }
  return out
}
