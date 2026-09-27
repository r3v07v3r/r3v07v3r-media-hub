// The per-key serial queue behind the tracking handlers' detached remote
// pushes (src/shared/media-hub/serialQueue.ts), and the one instance of it
// the main process keeps per title (src/main/media-hub/titlePushQueue.ts).
// Run with: npx tsx tests/serialQueue.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { titlePushQueue, titlePushKey } from '../src/main/media-hub/titlePushQueue'
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

  await check('titlePushKey is the id alone', () => {
    const bare = titlePushKey({ id: 'tt1' })
    // Callers disagree on `type` (undefined from the renderer, defaulted to
    // 'movie' elsewhere), so it must not be part of the key.
    assert.equal(titlePushKey({ id: 'tt1', type: 'movie' } as { id: string }), bare)
    assert.equal(titlePushKey({ id: 'tt1', type: 'series' } as { id: string }), bare)
    assert.notEqual(titlePushKey({ id: 'tt2' }), bare)
  })

  await check(
    'a plan push waits for a history push already queued for the same title',
    async () => {
      const events: string[] = []
      // The queue is a module singleton, so this id is used by no other check.
      const history = titlePushQueue.run(
        titlePushKey({ id: 'tt-order', type: 'series' } as { id: string }),
        async () => {
          events.push('history:start')
          await tick()
          await tick()
          events.push('history:done')
        }
      )
      const plan = titlePushQueue.run(
        titlePushKey({ id: 'tt-order', type: 'movie' } as { id: string }),
        async () => {
          events.push('plan:start')
        }
      )
      await Promise.all([history, plan])
      assert.deepEqual(events, ['history:start', 'history:done', 'plan:start'])
    }
  )

  await check('one per-title push queue in the main process', () => {
    const root = path.resolve(__dirname, '..')
    const dir = path.join(root, 'src', 'main')
    const files = (fs.readdirSync(dir, { recursive: true }) as string[])
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({
        // Windows returns backslashes; the assertion names a repo path.
        file: path.relative(root, path.join(dir, name)).split(path.sep).join('/'),
        text: fs.readFileSync(path.join(dir, name), 'utf8')
      }))
    // A second queue, or a hand-rolled chain, is a second order: pushes for
    // one title on two chains do not wait on each other.
    assert.deepEqual(
      files.filter(({ text }) => text.includes('createKeyedSerialQueue()')).map(({ file }) => file),
      ['src/main/media-hub/titlePushQueue.ts']
    )
    assert.deepEqual(
      files.filter(({ text }) => text.includes('planChangeChains')).map(({ file }) => file),
      []
    )
  })

  console.log(`\n${pass} passed`)
}

void main()
