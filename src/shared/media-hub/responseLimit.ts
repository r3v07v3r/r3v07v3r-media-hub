// A compromised or misconfigured media service must not be able to make the
// main process buffer an unbounded response before forwarding it to the
// renderer. Ten MiB is ample for the JSON payloads and diagnostic text this
// narrow proxy is intended to carry, while keeping a single request bounded.
export const MAX_PROXY_RESPONSE_BYTES = 10 * 1024 * 1024

function responseExceedsLimit(response: Response, maxBytes: number): boolean {
  const contentLength = response.headers.get('content-length')
  if (!contentLength) return false
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > maxBytes
}

/**
 * Reads a response with a hard byte ceiling, including for chunked responses
 * that do not declare Content-Length. `Response.text()`/`.json()` buffer the
 * entire body and therefore cannot enforce this boundary on their own.
 */
export async function readLimitedResponseText(
  response: Response,
  maxBytes: number = MAX_PROXY_RESPONSE_BYTES
): Promise<string> {
  if (responseExceedsLimit(response, maxBytes)) {
    await response.body?.cancel('Response exceeds size limit.')
    throw new Error('Proxy response exceeds size limit.')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel('Response exceeds size limit.')
        throw new Error('Proxy response exceeds size limit.')
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
  return new TextDecoder().decode(body)
}
