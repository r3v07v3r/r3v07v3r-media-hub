// A serial queue per key: tasks for the same key run one after another in
// the order they were queued; tasks for different keys do not wait on each
// other. Pure, so tests/serialQueue.test.ts can pin the ordering.
//
// Built for the tracking handlers' detached remote pushes. Those handlers
// answer on the local write and let the Simkl/Trakt/MAL pushes run behind
// it — so a "watched" and the "unwatched" that reverses it a moment later
// are both in flight together, in lanes whose concurrency is greater than
// one. If the add lands after the remove, the service says watched while
// this database says not, and nothing retries either. Ordering the pushes
// for one title is what closes that: the remove cannot start until the add
// has settled, whichever way it settled.

export interface KeyedSerialQueue {
  /**
   * Runs `task` after every task previously queued under `key` has
   * settled. Resolves when `task` settles; never rejects — a task's failure
   * is its own to report (each remote push logs its own), and must not
   * block the next task for the key.
   */
  run(key: string, task: () => Promise<unknown>): Promise<void>
  /** How many keys currently have a task running or waiting. */
  size(): number
}

export function createKeyedSerialQueue(): KeyedSerialQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    run(key, task) {
      const previous = tails.get(key) ?? Promise.resolve()
      const next: Promise<void> = previous
        .then(() => task())
        .then(
          () => undefined,
          () => undefined
        )
      tails.set(key, next)
      void next.then(() => {
        // Only the LAST task for a key clears its entry; an earlier one
        // finishing must not drop a tail that later tasks are chained on.
        if (tails.get(key) === next) tails.delete(key)
      })
      return next
    },
    size() {
      return tails.size
    }
  }
}
