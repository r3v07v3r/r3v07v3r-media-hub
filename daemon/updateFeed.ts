// The pure half of self-updating: version arithmetic and release-feed
// selection. No network, no filesystem — everything here is unit-tested,
// because this is the logic that decides what code the daemon will run
// next, and a mistake there doesn't crash, it installs the wrong thing.

/** The version shapes this project publishes: X.Y.Z (stable) and
 *  X.Y.Z-preview.N (the Preview channel — see preview.yml). */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** null = stable release; a number = preview build N of that version. */
  preview: number | null
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(String(value).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preview: match[4] === undefined ? null : Number(match[4])
  }
}

/**
 * Standard semver ordering, with this repo's one prerelease shape:
 * 1.0.84 > 1.0.84-preview.9 > 1.0.83 (a stable release outranks every
 * preview of the SAME version; a preview of a newer version outranks a
 * stable older one).
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if ((a.preview === null) !== (b.preview === null)) return a.preview === null ? 1 : -1
  return (a.preview ?? 0) - (b.preview ?? 0)
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  return compareVersions(a, b) > 0
}

/** The subset of a GitHub release the updater reads. */
export interface FeedRelease {
  tag_name?: string
  prerelease?: boolean
  draft?: boolean
  assets?: Array<{ name?: string; browser_download_url?: string }>
}

export interface UpdateCandidate {
  version: string
  bundleUrl: string
  checksumUrl: string
}

export type UpdateChannel = 'stable' | 'preview'

/** The asset name the updater installs. Deliberately the BUNDLE, not the
 *  SEA executable: the bundle is what the launcher requires, it is ~60KB
 *  instead of ~88MB, and replacing a running executable on Windows is a
 *  fight this design simply never has to have. */
export const UPDATE_ASSET = 'r3-cache.cjs'
export const UPDATE_CHECKSUM_ASSET = 'r3-cache.cjs.sha256'

/**
 * Picks the newest applicable release from a feed page.
 *
 * Channel rule matches the app's: 'preview' sees everything, 'stable'
 * sees only non-prerelease releases. A release without BOTH the bundle
 * and its checksum is skipped outright — an update that cannot be
 * verified is not an update, it is a download.
 */
export function selectUpdate(
  releases: readonly FeedRelease[],
  currentVersion: string,
  channel: UpdateChannel
): UpdateCandidate | null {
  let best: { parsed: ParsedVersion; candidate: UpdateCandidate } | null = null
  for (const release of releases) {
    if (release.draft) continue
    if (channel === 'stable' && release.prerelease) continue
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    const parsed = parseVersion(version)
    if (!parsed) continue
    if (!isNewerVersion(version, currentVersion)) continue
    const bundle = release.assets?.find((asset) => asset.name === UPDATE_ASSET)
    const checksum = release.assets?.find((asset) => asset.name === UPDATE_CHECKSUM_ASSET)
    if (!bundle?.browser_download_url || !checksum?.browser_download_url) continue
    if (best && compareVersions(parsed, best.parsed) <= 0) continue
    best = {
      parsed,
      candidate: {
        version,
        bundleUrl: bundle.browser_download_url,
        checksumUrl: checksum.browser_download_url
      }
    }
  }
  return best?.candidate ?? null
}

/**
 * Hosts an update may be downloaded from. The feed URL itself is
 * configurable (tests point it at a stub), but a PRODUCTION feed must not
 * be able to redirect the download to an arbitrary host: assets live on
 * GitHub, full stop. When the feed override is in use, its own host is
 * the one extra allowed origin.
 */
export function isAllowedUpdateUrl(url: string, feedOverrideHost?: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    if (feedOverrideHost && host === feedOverrideHost.toLowerCase()) return true
    if (parsed.protocol !== 'https:') return false
    return (
      host === 'github.com' ||
      host === 'api.github.com' ||
      host === 'objects.githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    )
  } catch {
    return false
  }
}
