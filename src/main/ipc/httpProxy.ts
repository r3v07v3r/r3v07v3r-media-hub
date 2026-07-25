import { ipcMain } from 'electron'
import { IPC_CHANNELS, ProxyRequest, ProxyResponse } from '../../shared/ipc-types'

// All Jellyfin/Sonarr/Radarr/qBittorrent calls are proxied through here
// rather than fetched directly from the renderer. Node's fetch in the main
// process isn't subject to browser CORS enforcement, which matters because
// most self-hosted media-server APIs don't send permissive CORS headers for
// a renderer-origin (file:// or the dev server's http://localhost) request.
export function registerHttpProxyIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.httpRequest,
    async (_event, req: ProxyRequest): Promise<ProxyResponse> => {
      const { url, method = 'GET', headers = {}, body, formBody, timeoutMs = 8000 } = req

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const finalHeaders = { ...headers }
        let finalBody: string | undefined
        if (formBody) {
          finalHeaders['Content-Type'] =
            finalHeaders['Content-Type'] ?? 'application/x-www-form-urlencoded'
          finalBody = new URLSearchParams(formBody).toString()
        } else if (body !== undefined) {
          finalBody = JSON.stringify(body)
        }

        const res = await fetch(url, {
          method,
          headers: finalHeaders,
          body: finalBody,
          signal: controller.signal
        })
        clearTimeout(timer)

        const contentType = res.headers.get('content-type') ?? ''
        const data = contentType.includes('application/json')
          ? await res.json().catch(() => undefined)
          : await res.text()

        // getSetCookie() (Node 18.17+/undici) returns each Set-Cookie header
        // separately — headers.get('set-cookie') would incorrectly merge
        // multiple cookies into one comma-joined string.
        const cookies = res.headers.getSetCookie?.() ?? []

        return {
          ok: res.ok,
          status: res.status,
          data,
          setCookie: cookies.length ? cookies.join('; ') : undefined
        }
      } catch (err) {
        clearTimeout(timer)
        const message = err instanceof Error ? err.message : 'Unknown network error'
        return { ok: false, status: 0, error: message }
      }
    }
  )
}
