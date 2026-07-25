import { ProxyRequest, ProxyResponse } from '@shared/ipc-types'

/** Thin wrapper over window.api.http.request (see src/main/ipc/httpProxy.ts)
 *  — every media-server/download-client call in lib/api routes through
 *  here rather than calling fetch() directly from the renderer, since the
 *  proxy runs in the main process where it isn't subject to browser CORS
 *  enforcement (see that file's doc comment for why that matters for
 *  self-hosted APIs). Returns a clear "not running in Electron" error when
 *  window.api isn't present (e.g. this code executing in a plain browser
 *  tab during dev-server/Playwright visual verification), rather than
 *  throwing on an undefined call.
 */
export async function proxyFetch<T = unknown>(req: ProxyRequest): Promise<ProxyResponse<T>> {
  if (!window.api?.http) {
    return {
      ok: false,
      status: 0,
      error: 'Not running inside the Electron app (no IPC bridge available)'
    }
  }
  try {
    const res = await window.api.http.request<T>(req)
    return res
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Unknown proxy error'
    }
  }
}
