// Post-processes the vite-plugin-singlefile output (preview-dist/index.html)
// into a fully self-contained browser preview:
//   1. Inlines every /media/... asset referenced in the bundle as a data:
//      URI (these live in public/ and aren't touched by Vite's own asset
//      pipeline/singlefile inlining, since public/ files are copied as-is).
//   2. Relaxes the app's CSP meta tag — the real Electron app's CSP
//      (script-src 'self') is right for a packaged desktop app loading its
//      own bundled JS via <script src>, but this preview inlines that same
//      JS as a literal <script> body, which 'self' alone won't permit.
//      This is a throwaway preview file, not the shipped app, so dropping
//      the tag here doesn't weaken anything real.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HTML_PATH = join(ROOT, 'preview-dist/index.html')
const PUBLIC_DIR = join(ROOT, 'src/renderer/public')
const TMDB_CACHE_DIR = join(ROOT, '.tmdb-cache')

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

let html = readFileSync(HTML_PATH, 'utf8')

// /reference/... is the dashboard-reference.png the debug ReferenceOverlay
// component (F8/F9/F10/F11) loads for pixel-alignment checks — not part of
// the normal user-facing UI, and at 2.3MB raw (~3.1MB base64) it's a
// meaningful chunk of the output size for a debug-only feature, so it's
// opt-in via INLINE_REFERENCE=1 (set when producing a build for local
// pixel-alignment verification) rather than inlined by default.
//
// Two distinct reference forms show up in the built bundle and BOTH must
// be matched:
//   - JS string literals (e.g. `backdropUrl: '/media/backdrops/x.jpg'` in
//     mockData.ts) survive the build as quoted, root-relative strings:
//     "/media/backdrops/x.jpg".
//   - CSS `url(...)` references (e.g. AIOrb's `background-image:
//     url("/media/ambient/ai-orb-core.jpg")`) get rewritten by Vite's CSS
//     asset pipeline into UNQUOTED, relative paths in the emitted
//     stylesheet: url(./media/ambient/ai-orb-core.jpg). An earlier version
//     of this script only matched the first (quote-wrapped, leading-slash)
//     form, which silently left every CSS-url()-referenced image
//     (ai-orb-core.jpg, nebula-field.jpg) as a broken relative file://
//     reference in the standalone preview — the orb rendered with no
//     swirl texture and the background with no nebula image, with no
//     error surfaced anywhere in this script's own log output. The
//     pattern below matches the path with its optional ./ or ../ prefix
//     captured as part of the match, and replacement is a plain substring
//     swap (no assumed surrounding quotes), so it fixes both forms at
//     once.
const INLINE_REFERENCE = process.env.INLINE_REFERENCE === '1'
const pathPattern = INLINE_REFERENCE
  ? /(?:\.\.?\/)?(?:media|reference)\/[a-zA-Z0-9_/.-]+\.(?:jpg|jpeg|png|svg)/g
  : /(?:\.\.?\/)?media\/[a-zA-Z0-9_/.-]+\.(?:jpg|jpeg|png|svg)/g
const found = new Set(html.match(pathPattern) ?? [])

let inlined = 0
for (const assetPath of found) {
  const normalized = assetPath.replace(/^(?:\.\.?\/)+/, '')
  const diskPath = join(PUBLIC_DIR, normalized)
  if (!existsSync(diskPath)) {
    console.warn(`skip (not found on disk): ${assetPath}`)
    continue
  }
  const ext = assetPath.slice(assetPath.lastIndexOf('.'))
  const mime = MIME[ext] ?? 'application/octet-stream'
  const base64 = readFileSync(diskPath).toString('base64')
  const dataUri = `data:${mime};base64,${base64}`
  html = html.split(assetPath).join(dataUri)
  inlined++
}

// Inline real TMDB artwork too — this preview is a standalone HTML file
// that may be rendered inside a sandboxed artifact viewer with no
// outbound network access, so a live https://image.tmdb.org/... <img src>
// would fail there even though it works fine in an ordinary browser.
// Baking the actual bytes in as data: URIs guarantees the hero art,
// Continue Watching thumbnails, and recommendation cards render
// everywhere, not just in environments that happen to allow the request
// through. Downgrades every reference to TMDB_WIDTH (default 500,
// override via env var — regardless of the width segment the app
// requested): ~100 images all embedded as base64 in one file adds up
// fast, and a delivered/persisted artifact has a hard size ceiling
// (10MB) that w780 alone (~7.9MB of images) left almost no room under.
// w500 averages ~26KB/image raw (~3.5MB base64 total for ~100 images)
// and is still perfectly legible at the sizes these render at here
// (largest is the hero, already softened by its own mask/scrim/blur
// treatment). Pass TMDB_WIDTH=780 for a higher-fidelity local build.
const TMDB_WIDTH = process.env.TMDB_WIDTH || '500'
const tmdbUrlPattern =
  /https:\/\/image\.tmdb\.org\/t\/p\/w\d+\/([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png))/g
const tmdbUrls = new Set(html.match(tmdbUrlPattern) ?? [])
let tmdbInlined = 0
let tmdbFailed = 0
if (tmdbUrls.size > 0) {
  mkdirSync(TMDB_CACHE_DIR, { recursive: true })
  for (const originalUrl of tmdbUrls) {
    const fileName = originalUrl.slice(originalUrl.lastIndexOf('/') + 1)
    const scaledUrl = `https://image.tmdb.org/t/p/w${TMDB_WIDTH}/${fileName}`
    const cachePath = join(TMDB_CACHE_DIR, `w${TMDB_WIDTH}-${fileName}`)
    if (!existsSync(cachePath)) {
      try {
        execFileSync('curl', ['-sf', '--max-time', '15', scaledUrl, '-o', cachePath], {
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } catch {
        console.warn(`skip (TMDB fetch failed): ${scaledUrl}`)
        tmdbFailed++
        continue
      }
    }
    const ext = fileName.slice(fileName.lastIndexOf('.'))
    const mime = MIME[ext] ?? 'image/jpeg'
    const base64 = readFileSync(cachePath).toString('base64')
    const dataUri = `data:${mime};base64,${base64}`
    html = html.split(`"${originalUrl}"`).join(`"${dataUri}"`)
    tmdbInlined++
  }
}

html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')

// Sandboxed iframes (no allow-same-origin) — which is how some preview
// hosts, e.g. an embedded artifact viewer, render an arbitrary HTML
// file via srcdoc — report window.origin as the literal string "null".
// react-router-dom's internal createURL() helper already special-cases
// that ("if origin is the string 'null', fall back to location.href as
// the base" — see its own R0() in the bundle), but a srcdoc iframe's
// location.href is "about:srcdoc", which is an *opaque-path* URL: the
// native URL constructor can't resolve a relative reference against an
// opaque base at all, so react-router's own fallback still throws
// "Failed to construct 'URL': Invalid URL" uncaught during React's
// first render, leaving the whole app a blank black screen. This shim
// retries any failed URL construction against a normal hierarchical
// base so relative paths resolve the way the app expects; if a URL is
// genuinely malformed for reasons unrelated to the base, the retry
// fails too and the original error still propagates. Must run before
// the bundled app script (hence injected right after <head>, ahead of
// every other <script> tag) so react-router's module-load-time URL
// calls are already patched by the time they run.
const SANDBOXED_ORIGIN_SHIM = `<script>
  (function () {
    var NativeURL = window.URL;
    function PatchedURL(url, base) {
      try {
        return new NativeURL(url, base);
      } catch (err) {
        try {
          return new NativeURL(url, 'http://localhost/');
        } catch {
          throw err;
        }
      }
    }
    PatchedURL.prototype = NativeURL.prototype;
    Object.setPrototypeOf(PatchedURL, NativeURL);
    window.URL = PatchedURL;
  })();
</script>`
html = html.replace(/<head>/i, `<head>\n    ${SANDBOXED_ORIGIN_SHIM}`)

writeFileSync(HTML_PATH, html)
console.log(
  `Inlined ${inlined}/${found.size} media assets, ${tmdbInlined}/${tmdbUrls.size} TMDB images ` +
    `(${tmdbFailed} failed). CSP tag removed. Sandboxed-origin URL shim injected.`
)
