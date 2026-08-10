export const PLAYBACK_PREPARATION_STAGES = [
  'resolving',
  'safety-checking',
  'buffering',
  'starting'
] as const

export type PlaybackPreparationStage = (typeof PLAYBACK_PREPARATION_STAGES)[number]

export const PLAYBACK_PREPARATION_LABELS: Record<PlaybackPreparationStage, string> = {
  resolving: 'Finding the best source',
  'safety-checking': 'Checking source safety',
  buffering: 'Preparing the stream',
  starting: 'Starting playback'
}

export class PlaybackPreparationTimeoutError extends Error {
  constructor(
    public readonly stage: PlaybackPreparationStage,
    public readonly timeoutMs: number
  ) {
    super(`${PLAYBACK_PREPARATION_LABELS[stage]} timed out.`)
    this.name = 'PlaybackPreparationTimeoutError'
  }
}

export class PlaybackPreparationCancelledError extends Error {
  constructor() {
    super('Playback preparation was cancelled.')
    this.name = 'PlaybackPreparationCancelledError'
  }
}

/**
 * Bounds one preparation stage and makes it locally cancellable. Electron IPC
 * promises themselves cannot be aborted, so callers must also ignore late
 * results and clean up any backend session they may eventually create.
 */
export function runPlaybackPreparationStage<T>(
  task: Promise<T>,
  stage: PlaybackPreparationStage,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(new PlaybackPreparationCancelledError())

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(new PlaybackPreparationCancelledError())
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new PlaybackPreparationTimeoutError(stage, timeoutMs))
    }, timeoutMs)

    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export function playbackPreparationErrorMessage(error: unknown): string {
  if (error instanceof PlaybackPreparationTimeoutError) {
    return `${error.message} Check the connection and try again.`
  }
  return error instanceof Error ? error.message : 'Playback failed to start.'
}
