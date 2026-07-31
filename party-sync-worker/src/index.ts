// R3-Party-Sync — the relay server the "relay" Watch Party mode expects
// (see src/main/media-hub/watchParty.ts's `mode === 'relay'` branches and
// settingsStore.ts's partySyncCredentials in the main r3v07v3r-media-hub
// app). That client code shipped first and already fixes the exact wire
// contract this has to implement:
//
//   POST /host  { inviteKey }  ->  { roomId, roomToken }
//   WS   /party/{roomId}?token=<roomToken-if-host>
//
// roomId must be a real UUID (the app's own isValidRelayEndpoint rejects
// anything else client-side). inviteKey is this deployment's own shared
// secret — set via `wrangler secret put INVITE_KEY` — so only people who
// know it can host a room on your Worker; nothing else here is
// authenticated (per-room isolation and the AES-256-GCM payload secret,
// which this server never even sees, are the real security boundary once
// a room exists).
//
// The actual per-room relay logic lives in room.ts's PartyRoom Durable
// Object — this file is just routing: create/initialize a room on /host,
// and forward every /party/{roomId} WebSocket upgrade to that same room's
// Durable Object instance (env.ROOMS.idFromName(roomId) always resolves to
// the identical instance for the same roomId, which is what lets multiple
// independent connections land in one shared broadcast group at all).

import { PartyRoom, type Env } from './room'

export { PartyRoom }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const ROOM_ID_PATTERN = /^\/party\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/host') {
      let body: { inviteKey?: string }
      try {
        body = (await request.json()) as { inviteKey?: string }
      } catch {
        return json({ error: 'Invalid request body.' }, 400)
      }
      if (!env.INVITE_KEY || body.inviteKey !== env.INVITE_KEY) {
        return json({ error: 'Invalid invite key.' }, 403)
      }

      const roomId = crypto.randomUUID()
      const roomToken = crypto.randomUUID()
      const id = env.ROOMS.idFromName(roomId)
      const stub = env.ROOMS.get(id)
      const initResponse = await stub.fetch('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ roomToken })
      })
      if (!initResponse.ok) return json({ error: 'Could not create party room.' }, 500)

      return json({ roomId, roomToken })
    }

    const match = url.pathname.match(ROOM_ID_PATTERN)
    if (match && request.headers.get('Upgrade') === 'websocket') {
      const roomId = match[1]
      const id = env.ROOMS.idFromName(roomId)
      const stub = env.ROOMS.get(id)
      return stub.fetch(request)
    }

    return json({ error: 'Not found.' }, 404)
  }
}
