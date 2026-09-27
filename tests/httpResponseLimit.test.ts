import assert from 'node:assert'
import { fetchJson, type HttpError } from '../src/main/media-hub/httpClient.ts'
import {
  MAX_PROXY_RESPONSE_BYTES,
  readLimitedResponseBytes,
  readLimitedResponseText,
  ResponseTooLargeError
} from '../src/shared/media-hub/responseLimit.ts'

let pass = 0

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

/** A body delivered as the given chunks, with no Content-Length header. */
function chunkedResponse(chunks: Uint8Array[], failAfter?: Error): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (failAfter) controller.error(failAfter)
      else controller.close()
    }
  })
  return new Response(stream)
}

/** Runs `fn` with the global fetch answering every request with `respond()`. */
async function withFetch<T>(respond: () => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => respond()) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

async function main(): Promise<void> {
  console.log('limited proxy response reads')
  await check('reads a bounded response', async () => {
    const text = await readLimitedResponseText(new Response('media-hub'))
    assert.equal(text, 'media-hub')
  })
  await check('rejects a response whose declared size is too large', async () => {
    const response = new Response('small', {
      headers: { 'content-length': String(MAX_PROXY_RESPONSE_BYTES + 1) }
    })
    await assert.rejects(() => readLimitedResponseText(response), /exceeds size limit/)
  })
  await check('rejects a chunked response after it crosses the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROXY_RESPONSE_BYTES))
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      }
    })
    await assert.rejects(() => readLimitedResponseText(new Response(stream)), /exceeds size limit/)
  })

  console.log('\nlimited byte reads')
  await check('returns the bytes of a body under the cap', async () => {
    const bytes = await readLimitedResponseBytes(new Response('abc'), 10)
    assert.deepEqual(Array.from(bytes), [97, 98, 99])
  })
  await check('accepts a streamed body exactly at the cap', async () => {
    const bytes = await readLimitedResponseBytes(
      chunkedResponse([new Uint8Array(4), new Uint8Array(4)]),
      8
    )
    assert.equal(bytes.byteLength, 8)
  })
  await check('accepts a declared length exactly at the cap', async () => {
    const response = new Response(new Uint8Array(8), { headers: { 'content-length': '8' } })
    assert.equal((await readLimitedResponseBytes(response, 8)).byteLength, 8)
  })
  await check('rejects a body one byte over the cap, with the caller message', async () => {
    await assert.rejects(
      () =>
        readLimitedResponseBytes(
          chunkedResponse([new Uint8Array(8), new Uint8Array(1)]),
          8,
          'Too big.'
        ),
      (error: unknown) => error instanceof ResponseTooLargeError && error.message === 'Too big.'
    )
  })
  await check('rejects a declared length over the cap before reading', async () => {
    let pulled = false
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const response = new Response(stream, { headers: { 'content-length': '9' } })
    await assert.rejects(() => readLimitedResponseBytes(response, 8), ResponseTooLargeError)
    assert.equal(pulled, false)
    assert.equal(cancelled, true)
  })
  await check('caps a body with no content-length by what arrives', async () => {
    const response = chunkedResponse([new Uint8Array(5), new Uint8Array(5)])
    assert.equal(response.headers.get('content-length'), null)
    await assert.rejects(() => readLimitedResponseBytes(response, 8), ResponseTooLargeError)
  })
  await check('an absent body reads as zero bytes', async () => {
    assert.equal((await readLimitedResponseBytes(new Response(null), 8)).byteLength, 0)
  })
  await check('a stream that errors midway rejects with that error', async () => {
    const failure = new Error('connection reset')
    await assert.rejects(
      () => readLimitedResponseBytes(chunkedResponse([new Uint8Array(2)], failure), 8),
      (error: unknown) => error === failure
    )
  })
  await check('the text reader keeps its proxy message', async () => {
    await assert.rejects(
      () => readLimitedResponseText(chunkedResponse([new Uint8Array(3)]), 2),
      (error: unknown) => (error as Error).message === 'Proxy response exceeds size limit.'
    )
  })

  console.log('\nfetchJson over a capped read')
  await check('parses a JSON body', async () => {
    const body = await withFetch(
      () => Response.json({ ok: 1 }),
      () => fetchJson<{ ok: number }>('https://example.test/a')
    )
    assert.deepEqual(body, { ok: 1 })
  })
  await check('a non-JSON body still becomes {}', async () => {
    const body = await withFetch(
      () => new Response('<html>not json</html>'),
      () => fetchJson('https://example.test/b')
    )
    assert.deepEqual(body, {})
  })
  await check('a body that fails midway still becomes {}', async () => {
    const body = await withFetch(
      () => chunkedResponse([new TextEncoder().encode('{"a"')], new Error('reset')),
      () => fetchJson('https://example.test/c')
    )
    assert.deepEqual(body, {})
  })
  await check('a non-ok status throws HttpError with body.detail', async () => {
    await withFetch(
      () => Response.json({ detail: 'Nope.' }, { status: 403 }),
      () =>
        assert.rejects(
          () => fetchJson('https://example.test/d'),
          (error: unknown) =>
            (error as HttpError).status === 403 && (error as Error).message === 'Nope.'
        )
    )
  })
  await check('body.error is used when there is no detail', async () => {
    await withFetch(
      () => Response.json({ error: 'Bad key.' }, { status: 401 }),
      () =>
        assert.rejects(
          () => fetchJson('https://example.test/e'),
          (error: unknown) =>
            (error as HttpError).status === 401 && (error as Error).message === 'Bad key.'
        )
    )
  })
  await check('success:false on a 200 throws with the status set', async () => {
    await withFetch(
      () => Response.json({ success: false }),
      () =>
        assert.rejects(
          () => fetchJson('https://example.test/f'),
          (error: unknown) =>
            (error as HttpError).status === 200 &&
            (error as Error).message === 'Request failed (200)'
        )
    )
  })
  await check('a body over the per-call cap rejects as a request error', async () => {
    await withFetch(
      () => chunkedResponse([new TextEncoder().encode('{"big":"'), new Uint8Array(64)]),
      () =>
        assert.rejects(
          () => fetchJson('https://example.test/g', {}, { maxResponseBytes: 32 }),
          ResponseTooLargeError
        )
    )
  })

  console.log(`\n${pass} passed`)
}

void main()
