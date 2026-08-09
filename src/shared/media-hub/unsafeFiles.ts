// What this app will not allow onto disk, and will not ask a debrid
// service to fetch on the person's behalf.
//
// This exists because it happened: torrents advertised as films delivered
// .exe files. That is not an accident of naming — bundling a dropper with
// (or instead of) the advertised media is one of the oldest deliveries on
// public trackers, and a media centre that streams video has no honest
// reason to ever write an executable anywhere.
//
// Kept pure and dependency-free, in shared/, for three reasons: the main
// process enforces it at the download boundary, the renderer wants to
// explain a block in the same words, and a list this security-relevant
// should be unit-testable without an Electron runtime.
//
// LOCAL, NOT REMOTE — deliberately, for now. A hosted/global list can be
// updated without shipping a build, which is a real advantage, but it
// also means the guard is only as available as the network and only as
// trustworthy as the transport; a list fetched over a compromised or
// absent connection either fails open (worse than useless) or fails
// closed (blocks everything). A compiled-in list has neither problem and
// costs nothing at runtime. `isBlockedFilename` takes an `extra` set so a
// remote list can be layered ON TOP later without this floor ever moving.

/**
 * Extensions that can execute, install, or script something on Windows,
 * macOS or Linux. Grouped by why they are here, because a bare list
 * invites someone to "tidy up" entries whose danger isn't obvious.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Native executables and installers
  'exe',
  'com',
  'scr', // screensaver — a PE executable wearing a different hat
  'pif', // legacy shortcut-to-DOS; still executed by Explorer
  'msi',
  'msp',
  'mst',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'dll',
  'sys',
  'drv',
  'cpl', // control-panel applet — a DLL that runs on double-click
  'ocx',
  'scf', // Explorer command file; historically ran without a prompt
  'lnk', // shortcut — the payload is the target, which you cannot see
  'url', // ditto, and can point at a UNC path
  'inf',
  'reg', // silently rewrites the registry on double-click
  'job',
  'application',
  'gadget',
  'msc',
  // Scripts and interpreters
  'bat',
  'cmd',
  'ps1',
  'ps1xml',
  'ps2',
  'psc1',
  'psm1',
  'psd1',
  'vb',
  'vbs',
  'vbe',
  'js', // Windows Script Host runs a bare .js on double-click
  'jse',
  'wsf',
  'wsh',
  'hta', // HTML application — full local trust
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'py',
  'pyc',
  'pyw',
  'pl',
  'php',
  'rb',
  'jar', // runs anywhere a JRE exists
  'class',
  // macOS / Linux
  'app',
  'dmg',
  'pkg',
  'mpkg',
  'command',
  'osx',
  'deb',
  'rpm',
  'run',
  'appimage',
  'bin',
  'elf',
  'so',
  'dylib',
  // Documents that are really programs
  'docm',
  'xlsm',
  'xlsb',
  'pptm',
  'dotm',
  'xltm',
  'potm',
  'ppam',
  'xlam',
  'iso', // mounts as a drive; the standard way to smuggle the above past
  'img',
  'vhd',
  'vhdx'
])

/** Download MIME types that mean "executable" regardless of filename. */
export const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-msi',
  'application/x-ms-installer',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sharedlib',
  'application/x-mach-binary',
  'application/x-apple-diskimage',
  'application/vnd.debian.binary-package',
  'application/x-rpm',
  'application/java-archive',
  'application/x-bat',
  'application/bat',
  'application/x-sh',
  'application/x-shellscript',
  'application/hta'
])

/**
 * Bidirectional and other invisible formatting characters, stripped before
 * any extension check because of one specific trick: U+202E (RIGHT-TO-LEFT
 * OVERRIDE) placed mid-filename reverses how everything after it is drawn,
 * so a file whose real name ends ".exe" can be made to display as though
 * it ends ".mkv". The file system, and Windows, still see .exe. Any check
 * that runs on the displayed string rather than the raw bytes is defeated
 * by it — see the "RTL override" case in tests/unsafeFiles.test.ts.
 *
 * Written as escapes, not literal characters: these are by definition
 * invisible, so a literal here is unreviewable and one stray keystroke
 * away from silently not matching.
 *
 *   200B-200F  zero-width space/non-joiner/joiner, LRM, RLM
 *   202A-202E  the embedding/override controls, including RLO
 *   2066-2069  the isolate controls
 *   FEFF       zero-width no-break space (BOM)
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * The filename as the operating system will actually resolve it.
 *
 * Two normalizations matter here and both are load-bearing:
 *
 * 1. Windows silently strips trailing dots and spaces when opening a
 *    path, so `payload.exe. ` IS `payload.exe` — a naive
 *    `endsWith('.exe')` check misses it and the file still runs.
 * 2. Only the basename is considered, so a directory named `x.exe`
 *    containing `film.mkv` isn't treated as an executable.
 */
function normalizeName(value: string): string {
  const withoutInvisible = String(value || '').replace(INVISIBLE_CHARS, '')
  const base = withoutInvisible.split(/[\\/]/).pop() || ''
  return base.replace(/[. \t]+$/, '').toLowerCase()
}

/** The effective extension the OS will dispatch on, or '' if there is none. */
export function effectiveExtension(filename: string): string {
  const name = normalizeName(filename)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1)
}

/**
 * Whether this filename is one the app refuses to write or fetch.
 *
 * Judged on the FINAL extension after normalization, which is the one the
 * OS dispatches on. That is what makes the classic `Movie.2024.1080p.mp4.exe`
 * a block and, correctly, leaves `Movie.exe.mkv` alone — the latter is a
 * genuine Matroska file with a silly name, and refusing to play it would
 * be a false positive on real media.
 *
 * `extra` layers additional extensions on top without touching the
 * compiled-in floor — the hook a remote/global list would use.
 */
export function isBlockedFilename(filename: string, extra?: ReadonlySet<string>): boolean {
  const ext = effectiveExtension(filename)
  if (!ext) return false
  return BLOCKED_EXTENSIONS.has(ext) || Boolean(extra?.has(ext))
}

export function isBlockedMimeType(mimeType: string): boolean {
  return BLOCKED_MIME_TYPES.has(
    String(mimeType || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
  )
}

/** A short, non-technical explanation for someone who just had a download
 *  refused. Names the extension, since "a file was blocked" with no
 *  specifics is the kind of message people learn to dismiss. */
export function blockedReason(filename: string, mimeType = ''): string | null {
  const ext = effectiveExtension(filename)
  if (isBlockedFilename(filename)) {
    return `".${ext}" files can run programs on your computer, so this app won't download them.`
  }
  if (isBlockedMimeType(mimeType)) {
    return 'That download is a program, not media, so this app blocked it.'
  }
  return null
}

/**
 * The blocked entries in a list of filenames — used to judge a torrent by
 * its contents before asking anyone to fetch it. Returns the offending
 * names (deduped, capped) rather than a boolean so the refusal can say
 * what it actually found.
 */
export function blockedFilesIn(names: readonly string[], limit = 5): string[] {
  const found: string[] = []
  for (const name of names) {
    if (!isBlockedFilename(name)) continue
    const base = String(name).split(/[\\/]/).pop() || String(name)
    if (found.includes(base)) continue
    found.push(base)
    if (found.length >= limit) break
  }
  return found
}

/**
 * Whether a release's own advertised text (its name, plus whatever file
 * listing the scraper add-on included in the description) mentions an
 * executable.
 *
 * Looser than isBlockedFilename on purpose, and used for a different
 * decision: this doesn't refuse to PLAY anything, it refuses to ask
 * TorBox to download a torrent in the first place. At that point there is
 * no file list to inspect — only the advertised text — so the question is
 * "does this claim to contain a program", and a substring match on a
 * token boundary is the honest answer available.
 *
 * Restricted to the extensions that are both unambiguous and actually
 * used in this attack (a full BLOCKED_EXTENSIONS sweep would match ".bin"
 * inside legitimate release names, and ".app" inside "...app.mkv"-style
 * junk, for no benefit).
 */
const RELEASE_TEXT_MARKERS =
  /\.(exe|msi|scr|bat|cmd|vbs|jar|hta|ps1|apk|dmg|pkg|lnk|iso)(?=$|[\s"'\],;:)|/\\])/i

export function releaseTextMentionsExecutable(text: string): boolean {
  return RELEASE_TEXT_MARKERS.test(String(text || '').replace(INVISIBLE_CHARS, ''))
}
