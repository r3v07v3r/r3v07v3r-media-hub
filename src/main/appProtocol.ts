import { protocol, net } from 'electron'
import { isAbsolute, join, normalize, relative } from 'path'
import { pathToFileURL } from 'url'

// The renderer is full of root-absolute asset references ("/media/...",
// carried over from the Next.js prototype where public/ was served from a
// true HTTP root) that a plain `loadFile()` (file://) load can't resolve —
// file:///.../out/renderer/index.html resolving "/media/x.jpg" means
// "/media/x.jpg" on the OS filesystem root, not the app's own renderer
// output. Serving the build over a custom app:// scheme with an explicit
// root, instead of file://, preserves the same root-relative path
// semantics the app already relies on (identical to how the Vite dev
// server behaves), so nothing else has to change for production.
export const APP_SCHEME = 'app'
const RENDERER_ROOT = join(__dirname, '../renderer')

export function registerAppSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

export function registerAppSchemeHandler(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    // app://index.html/media/x.jpg style URLs put the path in `pathname`
    // once the host is stripped; treat the whole thing after the scheme as
    // a root-relative path into RENDERER_ROOT.
    let relativePath = decodeURIComponent(url.pathname)
    if (!relativePath || relativePath === '/') relativePath = '/index.html'

    const filePath = normalize(join(RENDERER_ROOT, relativePath))
    // Guard against escaping RENDERER_ROOT via a crafted "../" path.
    const pathFromRoot = relative(RENDERER_ROOT, filePath)
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}
