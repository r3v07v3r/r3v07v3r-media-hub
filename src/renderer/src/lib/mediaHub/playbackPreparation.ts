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

/**
 * The title being got ready, for every Play button and both loading screens.
 *
 * `takeover`: started over a title that was playing (Play next, the bar's
 * Next episode, an episode picked in the player, a party moving on). That one
 * has been put away (playback:hold-for-next), so the wait gets the whole
 * window rather than the corner card — the page behind shows through it.
 * `heading` / `subheading` are what that screen says in the middle.
 */
export interface ResolvingMedia {
  id: string
  title: string
  stage: PlaybackPreparationStage
  detail?: string
  takeover?: boolean
  heading?: string
  subheading?: string
}

/** What the full-window loading screen turns into when its title could not
 *  start: the reason, and the ways on from it. */
export interface PlaybackTakeoverFailure {
  heading: string
  message: string
  retry: () => void
  /** Set up a source first, when there is none to play from. */
  setup?: { label: string; run: () => void }
}

/** Fields that only carry an episode — kept loose so both MediaItem and the
 *  overlay's NextEpisodeRef-shaped targets fit. */
interface TakeoverSubject {
  title: string
  mediaType?: string
  mediaKind?: string
  seasonNumber?: number | null
  episodeNumber?: number | null
  episodeTitle?: string | null
}

/**
 * What the full-window loading screen says: "Loading episode 12" with the
 * episode's own name (or the show's) under it; a film is just its title.
 * The season is named only beyond the first, where "episode 3" alone could
 * be any of several.
 */
export function takeoverHeadings(media: TakeoverSubject): { heading: string; subheading: string } {
  const isEpisodic =
    media.mediaKind === 'series' || media.mediaKind === 'anime' || media.mediaType === 'series'
  const episode = media.episodeNumber
  if (!isEpisodic || episode == null || !Number.isFinite(episode)) {
    return { heading: `Loading ${media.title}`, subheading: '' }
  }
  const season = media.seasonNumber
  const where =
    season != null && season > 1 ? `season ${season}, episode ${episode}` : `episode ${episode}`
  const name = media.episodeTitle?.trim()
  return {
    heading: `Loading ${where}`,
    subheading: name ? `${media.title} · ${name}` : media.title
  }
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
  // A rejected invoke arrives prefixed with the channel name; the person
  // gets the handler's own sentence.
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : 'Playback failed to start.'
}
