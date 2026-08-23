import assert from 'node:assert'
import {
  MAX_PROXY_RESPONSE_BYTES,
  readLimitedResponseText
} from '../src/shared/media-hub/responseLimit'

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
  console.log(`\n${pass} passed`)
}

void main()
