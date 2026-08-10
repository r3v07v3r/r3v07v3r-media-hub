import assert from 'node:assert/strict'
import {
  PlaybackPreparationCancelledError,
  PlaybackPreparationTimeoutError,
  playbackPreparationErrorMessage,
  runPlaybackPreparationStage
} from '../src/renderer/src/lib/mediaHub/playbackPreparation'

async function main(): Promise<void> {
  const active = new AbortController()
  assert.equal(
    await runPlaybackPreparationStage(Promise.resolve('ready'), 'resolving', 100, active.signal),
    'ready',
    'returns a successful stage result'
  )

  const cancelled = new AbortController()
  const pendingCancellation = runPlaybackPreparationStage(
    new Promise<never>(() => {}),
    'buffering',
    100,
    cancelled.signal
  )
  cancelled.abort()
  await assert.rejects(pendingCancellation, PlaybackPreparationCancelledError)

  const timeout = new AbortController()
  await assert.rejects(
    runPlaybackPreparationStage(new Promise<never>(() => {}), 'starting', 5, timeout.signal),
    (error: unknown) =>
      error instanceof PlaybackPreparationTimeoutError &&
      error.stage === 'starting' &&
      playbackPreparationErrorMessage(error).includes('Check the connection')
  )

  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort()
  await assert.rejects(
    runPlaybackPreparationStage(Promise.resolve('late'), 'resolving', 100, alreadyCancelled.signal),
    PlaybackPreparationCancelledError
  )

  console.log('ok  playback preparation success, cancellation, and timeout')
}

void main()
