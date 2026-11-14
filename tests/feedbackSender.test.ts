// How queued tester reports are split into requests the feedback Worker
// will take. See src/main/media-hub/feedback/reporter.ts's nextBatch.
// Run with: npx tsx tests/feedbackSender.test.ts

import assert from 'node:assert/strict'
import { nextBatch, type QueuedReport } from '../src/main/media-hub/feedback/reporter'
import { FEEDBACK_LIMITS, type FeedbackReport } from '../src/shared/feedback/types'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

function queued(log: string, n: number): QueuedReport[] {
  return Array.from({ length: n }, (_, i) => ({
    queuedAt: i,
    report: {
      v: 1,
      kind: 'crash',
      installId: 'abcd-1234-efgh',
      appVersion: '1.0.84',
      platform: 'win32 x64',
      occurredAt: '2026-11-14T00:00:00Z',
      title: `crash ${i}`,
      body: 'x'.repeat(FEEDBACK_LIMITS.body),
      log
    } satisfies FeedbackReport
  }))
}

const bytes = (batch: QueuedReport[]): number =>
  Buffer.byteLength(JSON.stringify({ reports: batch.map((item) => item.report) }), 'utf8')

check('small reports go twenty at a time', () => {
  assert.equal(nextBatch(queued('', 25)).length, FEEDBACK_LIMITS.batch)
})

check('reports with full logs are cut to the byte limit', () => {
  const items = queued('L'.repeat(FEEDBACK_LIMITS.log), 20)
  const batch = nextBatch(items)
  assert.ok(batch.length < 20, `took ${batch.length}`)
  assert.ok(bytes(batch) <= FEEDBACK_LIMITS.requestBytes, `${bytes(batch)} bytes`)
})

check('multi-byte text is measured in bytes, not characters', () => {
  const batch = nextBatch(queued('é'.repeat(FEEDBACK_LIMITS.log), 20))
  assert.ok(bytes(batch) <= FEEDBACK_LIMITS.requestBytes, `${bytes(batch)} bytes`)
})

check('the queue always moves: one report is always taken', () => {
  assert.equal(nextBatch(queued('L'.repeat(FEEDBACK_LIMITS.log), 1)).length, 1)
  assert.equal(nextBatch([]).length, 0)
})

console.log(`\n${pass} passed`)
