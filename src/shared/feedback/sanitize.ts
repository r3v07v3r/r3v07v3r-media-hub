// What a tester's report is cleaned of before it leaves their machine, and
// again when it arrives at the feedback Worker (feedback-worker/), so a
// pattern missed on one side is still caught on the other.
//
// The rule, from the person who reads these reports: a path says it is in
// the user's folder and what comes AFTER it, never whose folder it is.
// "C:\Users\Sam\AppData\Roaming\r3v07v3r-media-hub\logs" arrives as
// "%USERPROFILE%\AppData\Roaming\r3v07v3r-media-hub\logs". Everything else
// that identifies a person, a machine or a network, or unlocks an account,
// is replaced by a short marker saying what was there.
//
// Pure and dependency-free: the Electron main process, the renderer and the
// Worker all import this one file.

/** Hosts a report may name. A failing request to TorBox or Simkl is worth
 *  knowing about; anything else — somebody's own Jellyfin domain, their
 *  party relay's workers.dev subdomain, a LAN address — says who they are,
 *  so its URL becomes "[url]". */
const PUBLIC_HOSTS = [
  'torbox.app',
  'simkl.com',
  'simkl.in',
  'trakt.tv',
  'myanimelist.net',
  'themoviedb.org',
  'tmdb.org',
  'kitsu.app',
  'kitsu.io',
  'anilist.co',
  'strem.io',
  'strem.fun',
  'stremio.com',
  'opensubtitles.com',
  'opensubtitles.org',
  'subdl.com',
  'subtitledb.com',
  'omdbapi.com',
  'github.com',
  'githubusercontent.com',
  'youtube.com',
  'youtube-nocookie.com',
  'aniskip.com',
  'cloudflare.com'
]

function isPublicHost(host: string): boolean {
  const lower = host.toLowerCase()
  return PUBLIC_HOSTS.some((known) => lower === known || lower.endsWith(`.${known}`))
}

export interface SanitizeOptions {
  /** Literal strings to blank wherever they appear: the account name and
   *  the computer's name, which the main process knows and the patterns
   *  below cannot guess. Values shorter than 3 characters are ignored —
   *  blanking "a" would shred the text. */
  names?: { user?: string[]; computer?: string[] }
  /** Longest result; anything past it is cut with a marker. */
  maxLength?: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Order matters. Paths go first, so a file:// URL's path is cleaned rather
// than the whole URL thrown away; URLs before the bare-address and token
// rules, so a token in a query string goes with its URL.
const RULES: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  // file:///C:/Users/Sam/... -> the path alone, cleaned by the rules below.
  [/\bfile:\/{2,3}/gi, ''],
  // Windows user folders, with either slash and any doubling JSON or a
  // stack trace gives them: C:\Users\Sam, C:\\Users\\Sam, c:/users/sam.
  [
    /\b[A-Za-z]:(?:\\{1,2}|\/)+(?:Users|Documents and Settings)(?:\\{1,2}|\/)+[^\\/\s"'`<>|:*?]+/gi,
    '%USERPROFILE%'
  ],
  // macOS and Linux home folders.
  [/(^|[\s"'`(=:])\/(?:Users|home)\/[^/\s"'`]+/g, (_m, lead: string) => `${lead}~`],
  // Root's home on Linux.
  [/(^|[\s"'`(=:])\/root(?=\/|\b)/g, (_m, lead: string) => `${lead}~`],
  // Network shares: \\NAS\Media -> \\<server>\Media.
  [/\\\\(?!\?\\)[A-Za-z0-9._-]+(?=\\)/g, '\\\\<server>'],
  // Windows account SIDs.
  [/\bS-1-5-21(?:-\d+){1,5}\b/g, '[sid]'],
  // Magnet links name exactly what somebody was fetching, and carry trackers.
  [/\bmagnet:\?\S+/gi, '[magnet]'],
  // URLs: keep a known public host, drop the path and query everywhere.
  [
    /\b(?:https?|wss?|ftp):\/\/([^/\s"'`<>?#]+)[^\s"'`<>]*/gi,
    (_m, authority: string) => {
      const host = authority.replace(/^.*@/, '').replace(/:\d+$/, '')
      return isPublicHost(host) ? `https://${host.toLowerCase()}/…` : '[url]'
    }
  ],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // Bearer tokens and key=value secrets, as the app log already redacts
  // them (main/media-hub/logger.ts), plus JWTs.
  [
    /\b(bearer)(\s+)[A-Za-z0-9._~+/=-]+/gi,
    (_m, key: string, sep: string) => `${key}${sep}[secret]`
  ],
  [
    /\b(api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|client[_-]?secret|invite[_-]?key|join[_-]?secret|pin|session[_-]?id|device[_-]?code|user[_-]?code|auth[_-]?code)(["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi,
    (_m, key: string, sep: string) => `${key}${sep}[secret]`
  ],
  [
    /\b(authorization|cookie|set-cookie)(\s*:\s*)[^\n]*/gi,
    (_m, key: string, sep: string) => `${key}${sep}[secret]`
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[secret]'],
  // MAC addresses, before IPv6 so they are not half-read as one.
  [/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[mac]'],
  // IPv4 (loopback kept: "127.0.0.1 refused" is a useful sentence).
  [
    /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    (ip: string) => (ip.startsWith('127.') ? ip : '[ip]')
  ],
  // IPv6 with at least three groups (so a "12:30:45" time is left alone).
  [
    /\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4})?\b/g,
    '[ip]'
  ],
  // Long hex runs: info-hashes, API keys, device ids.
  [/\b[0-9A-Fa-f]{32,}\b/g, '[hex]'],
  // Long opaque runs of letters, digits and token punctuation — API keys
  // that are not hex. Needs a digit and a letter, so a long word is safe.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[secret]']
]

/** The app's own folder and package name, never a person's or a machine's. */
const APP_NAME = /r3v07v3r-media-hub/gi
/** A private-use character, which no report text contains, brackets each
 *  set-aside name while the account and computer names are blanked. */
const MARK = ''
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g')

/** Cleans one piece of text. Never throws. */
export function sanitizeText(value: unknown, options: SanitizeOptions = {}): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : value === undefined ? '' : String(value)
  } catch {
    return ''
  }
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, replacement as (substring: string, ...args: string[]) => string)
  }
  // The app's own name is set aside while names are blanked: a computer
  // or account named after the app (the developer's is) would otherwise
  // turn every path into "<computer>-media-hub".
  const keep: string[] = []
  text = text.replace(APP_NAME, (match) => `${MARK}${keep.push(match) - 1}${MARK}`)
  const literal = (values: string[] | undefined, marker: string): void => {
    for (const raw of values ?? []) {
      const name = raw?.trim()
      if (!name || name.length < 3) continue
      text = text.replace(new RegExp(escapeRegExp(name), 'gi'), marker)
    }
  }
  literal(options.names?.user, '<user>')
  literal(options.names?.computer, '<computer>')
  text = text.replace(MARKED, (_m, index: string) => keep[Number(index)] ?? '')
  const max = options.maxLength
  if (max && text.length > max) text = `${text.slice(0, max)}… [cut ${text.length - max} chars]`
  return text
}

/** Cleans every string inside a small JSON-ish value: a report's context. */
export function sanitizeValue<T>(value: T, options: SanitizeOptions = {}, depth = 0): T {
  if (typeof value === 'string') return sanitizeText(value, options) as T
  if (depth > 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, options, depth + 1)) as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    out[sanitizeText(key, options)] = sanitizeValue(item, options, depth + 1)
  }
  return out as T
}
