// A compromised or misconfigured media service must not be able to make the
// main process buffer an unbounded response before forwarding it to the
// renderer. Ten MiB is ample for the JSON payloads and diagnostic text this
// narrow proxy is intended to carry, while keeping a single request bounded.
export const MAX_PROXY_RESPONSE_BYTES = 10 * 1024 * 1024

/**
 * What a capped read throws when the body is larger than allowed. Its own
 * class so a caller that swallows ordinary body-read failures (a truncated
 * stream, an abort) can still let this one through.
 */
export class ResponseTooLargeError extends Error {
  constructor(message = 'Response exceeds size limit.') {
    super(message)
    this.name = 'ResponseTooLargeError'
  }
}

function responseExceedsLimit(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get('content-length')
  if (!contentLength) return false
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > maxBytes
}

/**
 * Reads a response body with a hard byte ceiling, including for chunked
 * responses that do not declare Content-Length. `Response.text()`, `.json()`
 * and `.arrayBuffer()` buffer the entire body and therefore cannot enforce
 * this boundary on their own: a declared length over the cap is refused
 * before anything is read, and the running total aborts the read the moment
 * it passes the cap either way. A stream that fails partway rejects with
 * that failure.
 *
 * Electron-free on purpose: the daemon and the main process both use it.
 */
export async function readLimitedResponseBytes(
  response: Response,
  maxBytes: number,
  tooLargeMessage?: string
): Promise<Uint8Array> {
  if (responseExceedsLimit(response, maxBytes)) {
    await response.body?.cancel('Response exceeds size limit.').catch(() => undefined)
    throw new ResponseTooLargeError(tooLargeMessage)
  }
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel('Response exceeds size limit.').catch(() => undefined)
        throw new ResponseTooLargeError(tooLargeMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** readLimitedResponseBytes, decoded as UTF-8 text. */
export async function readLimitedResponseText(
  response: Response,
  maxBytes: number = MAX_PROXY_RESPONSE_BYTES
): Promise<string> {
  const body = await readLimitedResponseBytes(
    response,
    maxBytes,
    'Proxy response exceeds size limit.'
  )
  return new TextDecoder().decode(body)
}
