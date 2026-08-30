// The app's side of the cache server's rooms hop.
//
// A room's socket normally goes straight to the Cloudflare relay. When a
// cache server is paired, the app subscribes through it instead — the
// daemon holds ONE upstream relay connection per room for the whole
// network and fans traffic locally (see daemon/roomsHop.ts). This file
// makes that transparent to rooms.ts: a HopSocket looks exactly like the
// relay WebSocket — same events, same raw envelopes — because the daemon
// forwards the relay's messages verbatim and synthesizes identical ones
// for the local echo.
//
// The E2E secret never appears here. What crosses the LAN is the same
// ciphertext that crosses the internet, plus the relay-level joinSecret
// the daemon needs to open the room's door — the trade docs/ROOMS.md
// names.

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

/** What rooms.ts needs from a socket — satisfied by both the relay
 *  WebSocket and the hop adapter, which is the whole point. */
export interface RoomSocket {
  /** `transient` marks a send the hop must never retain — re-keys,
   *  which must not be replayed to whoever subscribes next. The relay
   *  WebSocket ignores the option; retention there is guarded by the
   *  relay's own transport bans. */
  send(data: string, opts?: { transient?: boolean }): void
  close(): void
  on(event: 'message', listener: (raw: unknown) => void): unknown
  on(event: 'close' | 'error', listener: () => void): unknown
}

const SUBSCRIBE_TIMEOUT_MS = 6000

/** Adapts the relay's raw WebSocket to the RoomSocket shape. The only
 *  translation is dropping the hop-only `transient` option — the relay
 *  path needs no equivalent, because retention THERE is guarded by the
 *  relay's own transport bans. */
export function asRoomSocket(ws: WebSocket): RoomSocket {
  return {
    send: (data: string) => ws.send(data),
    close: () => {
      try {
        ws.close()
      } catch {
        // already down
      }
    },
    on: (event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void) =>
      ws.on(event, listener)
  }
}

class HopSocket extends EventEmitter implements RoomSocket {
  constructor(
    private readonly ws: WebSocket,
    private readonly roomId: string
  ) {
    super()
    ws.on('message', (raw) => {
      let msg: { type?: string; roomId?: string; raw?: string }
      try {
        msg = JSON.parse(String(raw)) as { type?: string; roomId?: string; raw?: string }
      } catch {
        return
      }
      if (msg.roomId !== this.roomId) return
      if (msg.type === 'msg' && typeof msg.raw === 'string') {
        // The relay's own envelope, untouched — rooms.ts parses it the
        // same way whichever path it took.
        this.emit('message', msg.raw)
      } else if (msg.type === 'room-down' || msg.type === 'room-kicked') {
        // room-down: the daemon lost the relay — a closed socket to
        // rooms.ts, whose backoff re-subscribes. room-kicked: the relay
        // banned this identity and the daemon dropped it; the same
        // close leads to a re-subscription the daemon refuses and a
        // direct connect the relay refuses, which is a removal doing
        // exactly what it says.
        this.emit('close')
        try {
          ws.close()
        } catch {
          // already down
        }
      }
    })
    ws.on('close', () => this.emit('close'))
    ws.on('error', () => this.emit('error'))
  }

  send(data: string, opts?: { transient?: boolean }): void {
    this.ws.send(
      JSON.stringify({
        type: 'send',
        roomId: this.roomId,
        body: data,
        ...(opts?.transient ? { transient: true } : {})
      })
    )
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already down
    }
  }
}

/**
 * Subscribes to one room through the cache server.
 *
 * Resolves only once the daemon has the upstream open (`sub-ok`), so a
 * resolved hop socket is as live as a resolved relay socket — the caller
 * never has to wonder which half is connected. Any failure rejects, and
 * the caller falls back to connecting direct; the hop is an optimisation
 * the household added, never a dependency the app acquired.
 */
export function connectHopWs(
  daemonUrl: string,
  daemonToken: string,
  sub: {
    roomId: string
    relayUrl: string
    join?: string
    /** The member's carry cryptogram — the tap the daemon forwards to
     *  the relay, which verifies it exactly like a direct admission.
     *  The daemon can deliver it but never mint it. Absent only for the
     *  legacy unsigned room, which has no membership at the relay. */
    cryptogram?: { pub: string; ts: number; ctr: number; sig: string }
  }
): Promise<RoomSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${daemonUrl.replace(/^http/, 'ws')}/api/rooms/hop?token=${encodeURIComponent(daemonToken)}`
    )
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('The cache server did not answer the room subscription.'))
    }, SUBSCRIBE_TIMEOUT_MS)
    ws.once('open', () => {
      // The cryptogram rides along — signed by this install's key,
      // bound to this relay and room and moment, verified by the RELAY
      // (never merely trusted by the daemon). What the daemon learns is
      // a public key and a spent signature; what it can do with them
      // anywhere else is nothing.
      ws.send(
        JSON.stringify({
          type: 'sub',
          roomId: sub.roomId,
          relayUrl: sub.relayUrl,
          ...(sub.join ? { join: sub.join } : {}),
          ...(sub.cryptogram ? { cryptogram: sub.cryptogram } : {})
        })
      )
    })
    const onFirst = (raw: unknown): void => {
      let msg: { type?: string; roomId?: string; error?: string }
      try {
        msg = JSON.parse(String(raw)) as { type?: string; roomId?: string; error?: string }
      } catch {
        return
      }
      if (msg.roomId !== sub.roomId) return
      if (msg.type === 'sub-ok') {
        clearTimeout(timer)
        ws.off('message', onFirst)
        resolve(new HopSocket(ws, sub.roomId))
      } else if (msg.type === 'sub-error') {
        clearTimeout(timer)
        ws.close()
        reject(new Error(msg.error || 'The cache server refused the room subscription.'))
      }
    }
    ws.on('message', onFirst)
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
