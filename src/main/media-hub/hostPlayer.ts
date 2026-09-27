// The player, when the HOST shows the video (platform.ts's hostPlayer): the
// Android app runs libmpv itself, under its WebView, because an Android app
// cannot hand its screen to a child process the way --wid hands a window to
// mpv on the desktop.
//
// Everything else stays the desktop's. MpvPlayer (mpv.ts) still talks to mpv
// over mpv's own JSON IPC socket — libmpv serves it exactly as the mpv binary
// does (proven on a phone in the Android spike) — so the whole command and
// observer layer runs unchanged. Only the spawn is replaced: instead of
// starting a process, this asks the host to start libmpv with the same
// arguments, and hands MpvPlayer something shaped enough like a ChildProcess
// for its lifecycle handling to hold.
//
// The request travels as one line on stdout, which the host already reads
// (android/.../Backend.kt):
//   [r3-host] {"type":"mpv-start","args":["--input-ipc-server=…", …]}
//   [r3-host] {"type":"mpv-stop"}
// No reply is needed: MpvPlayer already retries its socket connect until the
// player is listening, and gives up with a clear error if it never is.

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export const HOST_LINE_PREFIX = '[r3-host] '

type HostMessage = { type: 'mpv-start'; args: string[] } | { type: 'mpv-stop' }

function tellHost(message: HostMessage): void {
  process.stdout.write(`${HOST_LINE_PREFIX}${JSON.stringify(message)}\n`)
}

/** The part of ChildProcess MpvPlayer uses: `killed`, `pid`, `kill()`, an
 *  optional `stderr`, and `exit`. */
class HostPlayerProcess extends EventEmitter {
  killed = false
  readonly pid = 0
  readonly stderr = null

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    tellHost({ type: 'mpv-stop' })
    // Asynchronously, as a real process's exit is: MpvPlayer attaches its
    // listener just before calling kill().
    setImmediate(() => this.emit('exit', 0, null))
    return true
  }
}

/** Drop-in for MpvSpawnOptions.spawnImpl. The binary path is meaningless here
 *  (the player is inside the host), and ignored. */
export function hostSpawn(_path: string, args: readonly string[]): ChildProcess {
  tellHost({ type: 'mpv-start', args: [...args] })
  return new HostPlayerProcess() as unknown as ChildProcess
}
