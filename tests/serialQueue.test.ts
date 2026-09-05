// The per-key serial queue behind the tracking handlers' detached remote
// pushes (src/shared/media-hub/serialQueue.ts).
// Run with: npx tsx tests/serialQueue.test.ts

import assert from 'node:assert/strict'

import { createKeyedSerialQueue } from '../src/shared/media-hub/serialQueue'

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function main(): Promise<void> {
  await check('tasks for one key run in the order they were queued', async () => {
    const queue = createKeyedSerialQueue()
    const events: string[] = []
    // The first task is SLOW; without the queue the second would land first.
    const slowAdd = queue.run('tt1', async () => {
      events.push('add:start')
      await tick()
      await tick()
      events.push('add:done')
    })
    const remove = queue.run('tt1', async () => {
      events.push('remove:start')
      events.push('remove:done')
    })
    await Promise.all([slowAdd, remove])
    assert.deepEqual(events, ['add:start', 'add:done', 'remove:start', 'remove:done'])
  })

  await check('different keys do not wait on each other', async () => {
    const queue = createKeyedSerialQueue()
    const events: string[] = []
    const a = queue.run('a', async () => {
      await tick()
      await tick()
      events.push('a')
    })
    const b = queue.run('b', async () => {
      events.push('b')
    })
    await Promise.all([a, b])
    assert.deepEqual(events, ['b', 'a'])
  })

  await check('a failed task neither rejects nor blocks the next for its key', async () => {
    const queue = createKeyedSerialQueue()
    const events: string[] = []
    const failed = queue.run('k', async () => {
      throw new Error('service down')
    })
    const after = queue.run('k', async () => {
      events.push('after')
    })
    await failed
    await after
    assert.deepEqual(events, ['after'])
  })

  await check('a key is forgotten once its last task settles', async () => {
    const queue = createKeyedSerialQueue()
    const first = queue.run('k', async () => {
      await tick()
    })
    const second = queue.run('k', async () => {})
    assert.equal(queue.size(), 1)
    await first
    // The first finishing must not drop the tail the second is chained on.
    await second
    await tick()
    assert.equal(queue.size(), 0)
  })

  console.log(`\n${pass} passed`)
}

void main()
