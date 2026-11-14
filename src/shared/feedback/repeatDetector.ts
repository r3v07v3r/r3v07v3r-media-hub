// Spots somebody doing the same thing again and again — the sign that the
// first try did not work. Used in the renderer for clicks and screen
// changes, and in the main process for actions such as pressing Play on the
// same episode. Pure: the caller passes the time, so it can be tested.

export interface RepeatFinding {
  /** `rapid`: three or more within a second and a half, usually a control
   *  that looked like it did nothing. `repeated`: three or more within the
   *  window, usually an action that failed and was tried again. */
  pattern: 'rapid' | 'repeated'
  key: string
  count: number
  /** How long from the first of the run to this one. */
  spanMs: number
}

export interface RepeatDetectorOptions {
  /** How many make a run. */
  threshold?: number
  /** How far back a repeat counts. */
  windowMs?: number
  rapidMs?: number
  /** After a finding, the same key is quiet this long, so one frustrated
   *  minute is one report. */
  cooldownMs?: number
}

export class RepeatDetector {
  private readonly threshold: number
  private readonly windowMs: number
  private readonly rapidMs: number
  private readonly cooldownMs: number
  private readonly seen = new Map<string, number[]>()
  private readonly quietUntil = new Map<string, number>()

  constructor(options: RepeatDetectorOptions = {}) {
    this.threshold = options.threshold ?? 3
    this.windowMs = options.windowMs ?? 20_000
    this.rapidMs = options.rapidMs ?? 1_500
    this.cooldownMs = options.cooldownMs ?? 10 * 60_000
  }

  /** Records one occurrence; returns a finding when it completes a run. */
  note(key: string, now: number): RepeatFinding | null {
    if ((this.quietUntil.get(key) ?? 0) > now) return null
    const times = (this.seen.get(key) ?? []).filter((t) => now - t <= this.windowMs)
    times.push(now)
    this.seen.set(key, times)
    if (this.seen.size > 500) this.prune(now)
    if (times.length < this.threshold) return null
    const run = times.slice(-this.threshold)
    const spanMs = now - run[0]
    this.seen.delete(key)
    this.quietUntil.set(key, now + this.cooldownMs)
    return {
      pattern: spanMs <= this.rapidMs ? 'rapid' : 'repeated',
      key,
      count: times.length,
      spanMs
    }
  }

  private prune(now: number): void {
    for (const [key, times] of this.seen) {
      if (!times.some((t) => now - t <= this.windowMs)) this.seen.delete(key)
    }
    for (const [key, until] of this.quietUntil) if (until <= now) this.quietUntil.delete(key)
  }
}

/**
 * Going back and forth between the same two screens: A, B, A, B, A inside
 * the window. Usually somebody looking for something that is not where
 * they expect it. Returns the pair once, then stays quiet for the cooldown.
 */
export class PingPongDetector {
  private trail: Array<{ route: string; at: number }> = []
  private quietUntil = 0

  constructor(
    private readonly windowMs = 30_000,
    private readonly cooldownMs = 10 * 60_000
  ) {}

  note(route: string, now: number): { a: string; b: string; spanMs: number } | null {
    const last = this.trail[this.trail.length - 1]
    if (last?.route === route) return null
    this.trail = [
      ...this.trail.filter((step) => now - step.at <= this.windowMs),
      { route, at: now }
    ].slice(-5)
    if (now < this.quietUntil || this.trail.length < 5) return null
    const [a, b] = [this.trail[0].route, this.trail[1].route]
    const alternates = this.trail.every((step, i) => step.route === (i % 2 === 0 ? a : b))
    if (!alternates) return null
    this.quietUntil = now + this.cooldownMs
    const spanMs = now - this.trail[0].at
    this.trail = []
    return { a, b, spanMs }
  }
}
