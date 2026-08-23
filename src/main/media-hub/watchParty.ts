// Ported from r3v07v3r-media-hub's src/main.cjs (the Watch Party section:
// getLocalLanIp, partyMemberSummaries, partyBroadcast, broadcastPartyState,
// broadcastQueue, handlePartyMessage, closeParty, connectPartyWs,
// connectRelayWs, and every `party:*`/`party-sync:*` handler). The original
// kept a single module-level `party` object whose shape silently varied by
// `role`/`mode` (host-direct had `wss`/`port`/`upnpStop`, host-relay had
// `ws`/`relayUrl`/`roomId`, client had `selfId` and an array `members`
// instead of a host's `Map`, etc.) — untyped in JS, so nothing caught a
// handler reaching for a field that only exists on a different variant.
// Here that's modeled as an explicit `PartyState` discriminated union on
// `role`/`mode` so the compiler enforces exactly which fields exist in each
// of the four combinations. This is a legitimate typing improvement over
// the original; every runtime behavior, message shape, and error string
// below is preserved exactly.
//
// Direct/LAN/WAN hosting speaks a small custom WebSocket protocol
// (hello/welcome/leave/party-state/queue-sync, all AES-256-GCM encrypted
// via party.ts's encryptMessage/decryptMessage with a per-party shared
// secret) directly to peers. Relay hosting/joining speaks the same
// encrypted payloads, but wrapped in an unencrypted `{type:'relay',
// connId, isHost, body}` envelope produced by the external R3-Party-Sync
// worker. Do not change either wire format — it must keep interoperating
// with the original CommonJS app's install base and with the relay
// worker's existing protocol.

import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  ConnectResult,
  PartyEventPayload,
  PartyHostResult,
  PartyChatMessage,
  PartyMemberSummary,
  PartyMode,
  PartyQueueEntry,
  PartyStatusResult
} from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import {
  applyQueueEvent,
  createMemberId,
  decodeShareCode,
  encodeRelayShareCode,
  encodeShareCode,
  encryptMessage,
  decryptMessage,
  type PartyLanEndpoint,
  type PartyQueueEvent
} from './party'
import { encrypt, partySyncCredentials, readSettings, writeSettings } from './settingsStore'
import { sendToRenderer } from './rendererBridge'
import { sendToPlayerOverlay } from './playerWindow'
import { attemptPortMapping } from './upnp'
import { getLocalLanIp } from './network'

// Every message this protocol actually sends (hello/welcome/leave/
// party-state/queue-sync/playback actions) is small encrypted JSON — 64KB is
// generous headroom for any of them, never large enough to be a real memory-
// exhaustion vector from a malicious peer/relay/host. Applied to every `ws`
// constructor in this file (client and server) so it protects both
// directions: a joining member against a malicious host, and a host against
// a malicious member.
const MAX_PARTY_MESSAGE_BYTES = 64 * 1024
// A generous ceiling for a *watch* party, not a hard product limit — mainly
// a backstop against a leaked/guessed party code being used to pile on
// unbounded connections (each one holds a live socket + a Map entry on the
// host for as long as it stays open).
const MAX_PARTY_MEMBERS = 32

// A decrypted (or relay-envelope) message off the wire. Deliberately loose
// (mirrors the original's untyped `msg`/`envelope` objects) — every handler
// below narrows on `type` before touching any other field.
type PartyMessage = { type?: string; [key: string]: unknown }

interface PartyChatArgs {
  id?: string
  text?: string
  sentAt?: number
}

interface PartyHostMember {
  id: string
  name: string
  isHost: boolean
  /** See PartyMemberSummary.watching. Undefined until the member reports. */
  watching?: boolean
  // Only ever set for direct-mode host members (each has its own inbound
  // ws); relay-mode host members are reached through the single relay ws
  // instead, so this stays undefined/null for them — see partyBroadcast.
  ws?: WebSocket | null
}

interface PartyStateHostDirect {
  role: 'host'
  mode: 'direct'
  wss: WebSocketServer
  port: number
  secret: string
  members: Map<string, PartyHostMember>
  hostId: string
  selfName: string
  hostName: string
  queue: PartyQueueEntry[]
  upnpStop?: () => void
  allowMemberControl: boolean
}

interface PartyStateHostRelay {
  role: 'host'
  mode: 'relay'
  ws: WebSocket
  relayUrl: string
  roomId: string
  secret: string
  members: Map<string, PartyHostMember>
  hostId: string
  selfName: string
  hostName: string
  queue: PartyQueueEntry[]
  allowMemberControl: boolean
}

interface PartyStateClientDirect {
  role: 'client'
  mode: 'direct'
  ws: WebSocket
  secret: string
  members: PartyMemberSummary[]
  selfName: string
  hostName: string
  selfId: string
  queue: PartyQueueEntry[]
  allowMemberControl: boolean
}

interface PartyStateClientRelay {
  role: 'client'
  mode: 'relay'
  ws: WebSocket
  secret: string
  members: PartyMemberSummary[]
  selfName: string
  hostName: string
  selfId: string
  queue: PartyQueueEntry[]
  allowMemberControl: boolean
}

type PartyState =
  PartyStateHostDirect | PartyStateHostRelay | PartyStateClientDirect | PartyStateClientRelay

let party: PartyState | null = null

function partyMemberSummaries(): PartyMemberSummary[] {
  const current = party
  if (!current) return []
  if (current.role === 'host') {
    return [...current.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      isHost: m.isHost,
      watching: m.watching
    }))
  }
  return current.members || []
}

function partyBroadcast(payload: string): void {
  const current = party
  if (!current) return
  if (current.role === 'host' && current.mode !== 'relay') {
    for (const m of current.members.values()) {
      if (m.ws && m.ws.readyState === WebSocket.OPEN) m.ws.send(payload)
    }
    return
  }
  if (current.ws && current.ws.readyState === WebSocket.OPEN) current.ws.send(payload)
}

/** The application window and the native player controls are separate
 * renderers. Room state has to reach both: without this, the player could
 * synchronise playback but had no way to show the people or conversation it
 * was synchronising with. */
function sendPartyEvent(payload: PartyEventPayload): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.partyEvent, payload)
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.partyEvent, payload)
}

function broadcastPartyState(): void {
  const current = party
  if (!current || current.role !== 'host') return
  const members = partyMemberSummaries()
  const payload = encryptMessage(current.secret, {
    type: 'party-state',
    members,
    allowMemberControl: current.allowMemberControl
  })
  partyBroadcast(payload)
  sendPartyEvent({
    type: 'party-state',
    members,
    allowMemberControl: current.allowMemberControl
  })
}

function broadcastQueue(): void {
  const current = party
  if (!current || current.role !== 'host') return
  const payload = encryptMessage(current.secret, { type: 'queue-sync', queue: current.queue })
  partyBroadcast(payload)
  sendPartyEvent({ type: 'queue-sync', queue: current.queue })
}

function handlePartyMessage(fromId: string, msg: PartyMessage): void {
  const current = party
  if (msg?.type === 'chat') {
    const incoming = msg.chat as Partial<PartyChatMessage> | undefined
    const text = typeof incoming?.text === 'string' ? incoming.text.trim().slice(0, 1000) : ''
    if (!incoming || !text || typeof incoming.id !== 'string') return
    const chat: PartyChatMessage = {
      id: incoming.id.slice(0, 80),
      senderId: fromId,
      senderName:
        typeof incoming.senderName === 'string' && incoming.senderName.trim()
          ? incoming.senderName.trim().slice(0, 40)
          : current?.members && current.role === 'host'
            ? current.members.get(fromId)?.name || 'Someone'
            : 'Someone',
      text,
      sentAt:
        typeof incoming.sentAt === 'number' && Number.isFinite(incoming.sentAt)
          ? incoming.sentAt
          : Date.now()
    }
    // Direct parties need the host to forward a member's message. Relay
    // rooms already fan it out, so forwarding there would duplicate it.
    if (current?.role === 'host' && current.mode === 'direct') {
      const payload = encryptMessage(current.secret, { type: 'chat', chat })
      for (const [id, member] of current.members) {
        if (id !== fromId && member.ws && member.ws.readyState === WebSocket.OPEN) {
          member.ws.send(payload)
        }
      }
    }
    sendPartyEvent({ type: 'chat', chat })
    return
  }
  // Presence. Host-side only bookkeeping: record whether this member has a
  // player open, then push the updated roster so every client's seek quorum
  // (see checkPartySeekReady in PlaybackOverlay.tsx) agrees on who can
  // actually be waited on. Not gated on host-control — this is a member
  // reporting its own state, exactly like 'ready'.
  if (current?.role === 'host' && msg?.type === 'watching') {
    const member = current.members.get(fromId)
    if (member) {
      member.watching = msg.watching === true
      broadcastPartyState()
    }
    return
  }
  if (current?.role === 'host' && msg?.type === 'play-request') {
    sendPartyEvent({
      type: 'play-request',
      item: msg.item as { id: string; type: string; title: string; poster?: string }
    })
    return
  }
  if (current?.role === 'host' && (msg?.type === 'suggest' || msg?.type === 'vote')) {
    const event: PartyQueueEvent =
      msg.type === 'vote'
        ? {
            type: 'vote',
            queueId: String(msg.queueId || ''),
            voterId: fromId,
            direction: Number(msg.direction)
          }
        : {
            type: 'suggest',
            queueId: String(msg.queueId || ''),
            item: msg.item as PartyQueueEntry['item'],
            suggestedBy:
              current.members.get(fromId)?.name ||
              (msg.suggestedBy as string | undefined) ||
              'Someone'
          }
    current.queue = applyQueueEvent(current.queue, event)
    broadcastQueue()
    return
  }
  if (current?.role === 'host' && msg?.type === 'seek' && !current.allowMemberControl) return
  if (current?.role === 'host' && current.mode !== 'relay') {
    const payload = encryptMessage(current.secret, { ...msg, from: fromId })
    for (const [id, m] of current.members) {
      if (id !== fromId && m.ws && m.ws.readyState === WebSocket.OPEN) m.ws.send(payload)
    }
  }
  sendPartyEvent({ type: 'message', from: fromId, message: msg })
}

/** Tears down the active party (host: closes the ws server/all member sockets and stops any UPnP mapping; client/relay-host: sends a best-effort `leave` then closes its socket) and clears `party`. Called both from `party:leave` and from `app.on('before-quit', ...)` in src/main/index.ts. */
export function closeParty(): void {
  const current = party
  if (!current) return
  if (current.role === 'host' && current.mode !== 'relay') {
    for (const m of current.members.values()) {
      try {
        m.ws?.close()
      } catch {
        // best-effort
      }
    }
    try {
      current.wss.close()
    } catch {
      // best-effort
    }
    current.upnpStop?.()
  } else {
    if (current.mode === 'relay') {
      try {
        current.ws.send(encryptMessage(current.secret, { type: 'leave' }))
      } catch {
        // best-effort
      }
    }
    try {
      current.ws.close()
    } catch {
      // best-effort
    }
  }
  party = null
}

function connectPartyWs(
  endpoint: PartyLanEndpoint,
  secret: string,
  name: string
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${endpoint.ip}:${endpoint.port}`, {
      maxPayload: MAX_PARTY_MESSAGE_BYTES
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('Connection timed out.'))
    }, 5000)
    ws.once('open', () => {
      clearTimeout(timer)
      ws.send(encryptMessage(secret, { type: 'hello', name }))
      resolve(ws)
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

interface ConnectRelayOptions {
  token?: string
  secret?: string
  helloName?: string
  WebSocketImpl?: typeof WebSocket
}

/** Shared with friends.ts, which opens a long-lived connection to a group
 *  room using exactly the same relay protocol. */
export function connectRelayWs(
  relayUrl: string,
  roomId: string,
  { token = '', secret = '', helloName = '', WebSocketImpl = WebSocket }: ConnectRelayOptions = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/party/${encodeURIComponent(roomId)}${
      token ? `?token=${encodeURIComponent(token)}` : ''
    }`
    const ws = new WebSocketImpl(wsUrl, undefined, { maxPayload: MAX_PARTY_MESSAGE_BYTES })
    const timer = setTimeout(() => {
      ws.terminate?.()
      reject(new Error('R3-Party-Sync connection timed out.'))
    }, 8000)
    ws.once('open', () => {
      clearTimeout(timer)
      if (helloName) ws.send(encryptMessage(secret, { type: 'hello', name: helloName }))
      resolve(ws)
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

interface PartyHostArgs {
  name?: string
  mode?: PartyMode
}

interface PartyJoinArgs {
  code?: string
  name?: string
}

interface PartySuggestArgs {
  id?: unknown
  type?: string
  title?: string
  poster?: string
  year?: string
}

interface PartyVoteArgs {
  queueId?: string
  direction?: number
}

interface PartyPreparingArgs {
  item?: { id?: string; type?: string; title?: string; poster?: string } | null
}

interface PartyNowPlayingArgs {
  infoHash?: string
  sources?: string[]
  mediaId?: string
  item?: { id?: string; type?: string; title?: string; poster?: string }
  season?: number
  episode?: number
  position?: number
}

interface PartyPlaybackActionArgs {
  type?: string
  watching?: boolean
  paused?: boolean
  position?: number
  requestId?: string
  waitingIds?: string[]
}

interface PartySyncConnectArgs {
  url?: string
  inviteKey?: string
}

/** Registers every `party:*` and `party-sync:*` IPC handler (hosting — direct LAN/WAN with optional UPnP, and relay via R3-Party-Sync —, joining, leaving, status, queue suggest/remove/vote, now-playing/playback-action broadcast, and R3-Party-Sync connect/disconnect). */
export function registerWatchPartyIpc(): void {
  handle<PartyHostArgs, PartyHostResult>(MEDIA_HUB_CHANNELS.partyHost, async (_e, payload) => {
    if (party) throw new Error('You are already in a party. Leave it first.')
    const { name: rawName, mode } = payload || {}
    const name =
      String(rawName || 'Host')
        .trim()
        .slice(0, 40) || 'Host'

    if (mode === 'relay') {
      const creds = partySyncCredentials()
      if (!creds.url || !creds.inviteKey)
        throw new Error('Configure R3-Party-Sync in Settings first.')
      const { roomId, roomToken } = await fetchJson<{ roomId: string; roomToken: string }>(
        `${creds.url}/host`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inviteKey: creds.inviteKey })
        }
      )
      const secret = crypto.randomBytes(24).toString('base64url')
      const members = new Map<string, PartyHostMember>()
      const hostId = createMemberId()
      members.set(hostId, { id: hostId, name, isHost: true })
      const ws = await connectRelayWs(creds.url, roomId, { token: roomToken })
      const hostRelayState: PartyStateHostRelay = {
        role: 'host',
        mode: 'relay',
        ws,
        relayUrl: creds.url,
        roomId,
        secret,
        members,
        hostId,
        selfName: name,
        hostName: name,
        queue: [],
        allowMemberControl: false
      }
      party = hostRelayState
      ws.on('message', (raw) => {
        let envelope: { type?: string; connId?: string; body?: string; isHost?: boolean }
        try {
          envelope = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (envelope.type !== 'relay') return
        const msg = decryptMessage(secret, envelope.body || '') as PartyMessage | null
        if (!msg) return
        const fromId = String(envelope.connId || '')
        if (msg.type === 'hello') {
          if (!members.has(fromId) && members.size >= MAX_PARTY_MEMBERS) return
          members.set(fromId, {
            id: fromId,
            name: String(msg.name || 'Guest').slice(0, 40) || 'Guest',
            isHost: false
          })
          broadcastPartyState()
          return
        }
        if (msg.type === 'leave') {
          if (members.delete(fromId)) broadcastPartyState()
          return
        }
        if (!members.has(fromId)) return
        handlePartyMessage(fromId, msg)
      })
      ws.on('close', () => {
        if (party?.role === 'host' && party.mode === 'relay') {
          party = null
          sendPartyEvent({ type: 'host-disconnected' })
        }
      })
      return {
        ok: true,
        code: encodeRelayShareCode({ relay: { url: creds.url, roomId }, secret, name }),
        wanAvailable: true
      }
    }

    const secret = crypto.randomBytes(24).toString('base64url')
    const wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const server = new WebSocketServer({
        host: '0.0.0.0',
        port: 0,
        maxPayload: MAX_PARTY_MESSAGE_BYTES
      })
      server.once('listening', () => resolve(server))
      server.once('error', reject)
    })
    const address = wss.address()
    const port = typeof address === 'string' || address === null ? 0 : address.port
    const members = new Map<string, PartyHostMember>()
    const hostId = createMemberId()
    members.set(hostId, { id: hostId, name, isHost: true, ws: null })
    const hostDirectState: PartyStateHostDirect = {
      role: 'host',
      mode: 'direct',
      wss,
      port,
      secret,
      members,
      hostId,
      selfName: name,
      hostName: name,
      queue: [],
      allowMemberControl: false
    }
    party = hostDirectState
    wss.on('connection', (ws) => {
      let memberId: string | null = null
      ws.on('message', (raw) => {
        const msg = decryptMessage(secret, raw.toString()) as PartyMessage | null
        if (!msg) {
          ws.close()
          return
        }
        if (msg.type === 'hello' && !memberId) {
          if (members.size >= MAX_PARTY_MEMBERS) {
            ws.close()
            return
          }
          memberId = createMemberId()
          members.set(memberId, {
            id: memberId,
            name: String(msg.name || 'Guest').slice(0, 40) || 'Guest',
            isHost: false,
            ws
          })
          ws.send(encryptMessage(secret, { type: 'welcome', id: memberId }))
          broadcastPartyState()
          return
        }
        if (!memberId) return
        handlePartyMessage(memberId, msg)
      })
      ws.on('close', () => {
        if (memberId) {
          members.delete(memberId)
          broadcastPartyState()
        }
      })
    })
    const mapping = await attemptPortMapping(port, getLocalLanIp()).catch(() => null)
    const lan: PartyLanEndpoint = { ip: getLocalLanIp(), port }
    const wan: PartyLanEndpoint | null = mapping ? { ip: mapping.ip, port: mapping.port } : null
    if (mapping && party && party.role === 'host' && party.mode === 'direct') {
      party.upnpStop = mapping.stop
    }
    const code = encodeShareCode({ lan, wan, secret, name })
    return { ok: true, code, port, wanAvailable: Boolean(wan) }
  })

  handle<PartyJoinArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyJoin, async (_e, payload) => {
    if (party) throw new Error('You are already in a party. Leave it first.')
    const { code, name } = payload || {}
    const parsed = decodeShareCode(code)
    if (!parsed) throw new Error('That party code is invalid.')
    const displayName =
      String(name || 'Guest')
        .trim()
        .slice(0, 40) || 'Guest'

    if (parsed.v === 2) {
      const ws = await connectRelayWs(parsed.relay.url, parsed.relay.roomId, {
        secret: parsed.secret,
        helloName: displayName
      })
      const clientRelayState: PartyStateClientRelay = {
        role: 'client',
        mode: 'relay',
        ws,
        secret: parsed.secret,
        members: [],
        selfName: displayName,
        hostName: parsed.name || '',
        selfId: '',
        queue: [],
        allowMemberControl: false
      }
      party = clientRelayState
      ws.on('message', (raw) => {
        let envelope: { type?: string; connId?: string; body?: string; isHost?: boolean }
        try {
          envelope = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (envelope.type === 'assigned') {
          if (party?.role === 'client') party.selfId = String(envelope.connId || '')
          return
        }
        // `retained` (the relay replaying a member's last message on
        // connect — see the worker's room.ts) is deliberately IGNORED for
        // parties. It exists for friends-group presence, where stale state
        // is still useful; replaying a minutes-old nowPlaying or position
        // into live playback would be actively wrong. A party's own
        // late-join path (nowPlaying + partyPendingSeek) already covers it.
        if (envelope.type !== 'relay') return
        const msg = decryptMessage(parsed.secret, envelope.body || '') as PartyMessage | null
        if (!msg) return
        if (msg.type === 'party-state') {
          const members = (msg.members as PartyMemberSummary[]) || []
          const allowMemberControl = Boolean(msg.allowMemberControl)
          if (party?.role === 'client') {
            party.members = members
            party.allowMemberControl = allowMemberControl
          }
          sendPartyEvent({
            type: 'party-state',
            members,
            allowMemberControl
          })
          return
        }
        if (msg.type === 'queue-sync') {
          if (party?.role === 'client') {
            party.queue = applyQueueEvent(party.queue, msg as unknown as PartyQueueEvent)
            sendPartyEvent({
              type: 'queue-sync',
              queue: party.queue
            })
          }
          return
        }
        if (envelope.isHost && msg.type === 'leave') {
          party = null
          sendPartyEvent({ type: 'host-disconnected' })
          return
        }
        if (!envelope.isHost && msg.type === 'nowPlaying') return
        if (
          !envelope.isHost &&
          msg.type === 'seek' &&
          !(party?.role === 'client' && party.allowMemberControl)
        )
          return
        handlePartyMessage(envelope.isHost ? 'host' : String(envelope.connId || ''), msg)
      })
      ws.on('close', () => {
        if (party?.role === 'client') {
          party = null
          sendPartyEvent({ type: 'host-disconnected' })
        }
      })
      return { ok: true }
    }

    const endpoints: PartyLanEndpoint[] = [parsed.lan, parsed.wan].filter(
      (endpoint): endpoint is PartyLanEndpoint => Boolean(endpoint)
    )
    let ws: WebSocket | null = null
    let lastError: unknown = null
    for (const endpoint of endpoints) {
      try {
        ws = await connectPartyWs(endpoint, parsed.secret, displayName)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!ws) {
      throw new Error(
        lastError instanceof Error ? lastError.message : 'Could not reach the party host.'
      )
    }
    const connectedWs = ws
    const clientDirectState: PartyStateClientDirect = {
      role: 'client',
      mode: 'direct',
      ws: connectedWs,
      secret: parsed.secret,
      members: [],
      selfName: displayName,
      hostName: parsed.name || '',
      selfId: '',
      queue: [],
      allowMemberControl: false
    }
    party = clientDirectState
    connectedWs.on('message', (raw) => {
      const msg = decryptMessage(parsed.secret, raw.toString()) as PartyMessage | null
      if (!msg) return
      if (msg.type === 'welcome') {
        if (party?.role === 'client') party.selfId = String(msg.id || '')
        return
      }
      if (msg.type === 'party-state') {
        const members = (msg.members as PartyMemberSummary[]) || []
        const allowMemberControl = Boolean(msg.allowMemberControl)
        if (party?.role === 'client') {
          party.members = members
          party.allowMemberControl = allowMemberControl
        }
        sendPartyEvent({
          type: 'party-state',
          members,
          allowMemberControl
        })
        return
      }
      if (msg.type === 'queue-sync') {
        if (party?.role === 'client') {
          party.queue = applyQueueEvent(party.queue, msg as unknown as PartyQueueEvent)
          sendPartyEvent({ type: 'queue-sync', queue: party.queue })
        }
        return
      }
      handlePartyMessage('host', msg)
    })
    connectedWs.on('close', () => {
      if (party?.role === 'client') {
        party = null
        sendPartyEvent({ type: 'host-disconnected' })
      }
    })
    return { ok: true }
  })

  handle(MEDIA_HUB_CHANNELS.partyLeave, () => {
    closeParty()
    return { ok: true }
  })

  handle<undefined, PartyStatusResult>(MEDIA_HUB_CHANNELS.partyStatus, () => {
    const current = party
    if (!current) return { inParty: false }
    return {
      inParty: true,
      role: current.role,
      mode: current.mode || 'direct',
      members: partyMemberSummaries(),
      selfId: current.role === 'host' ? current.hostId : current.selfId || '',
      selfName: current.selfName || '',
      hostName: current.hostName || '',
      allowMemberControl: Boolean(current.allowMemberControl)
    }
  })

  handle<{ allow?: boolean }, { ok: true }>(
    MEDIA_HUB_CHANNELS.partySetMemberControl,
    (_e, payload) => {
      const current = party
      if (!current || current.role !== 'host') throw new Error('Only the host can change this.')
      current.allowMemberControl = Boolean(payload?.allow)
      broadcastPartyState()
      return { ok: true }
    }
  )

  handle<{ item?: PartyQueueEntry['item'] }, { ok: true }>(
    MEDIA_HUB_CHANNELS.partyRequestPlay,
    (_e, payload) => {
      const current = party
      if (!current) throw new Error('You are not in a party.')
      const item = payload?.item
      if (!item?.id || !item.type) throw new Error('Nothing to play.')
      const event = {
        type: 'play-request' as const,
        item: { id: item.id, type: item.type, title: item.title, poster: item.poster || '' }
      }
      if (current.role === 'host') {
        sendPartyEvent({ type: 'play-request', item: event.item })
      } else {
        partyBroadcast(encryptMessage(current.secret, event))
      }
      return { ok: true }
    }
  )

  handle<PartySuggestArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partySuggest, (_e, item) => {
    const current = party
    if (!current) throw new Error('You are not in a party.')
    if (!item || item.id === undefined || item.id === null) throw new Error('Nothing to suggest.')
    const cleanItem: PartyQueueEntry['item'] = {
      id: item.id as string,
      type: item.type as string,
      title: item.title as string,
      poster: item.poster || '',
      year: item.year || ''
    }
    const event: PartyQueueEvent = {
      type: 'suggest',
      queueId: createMemberId(),
      item: cleanItem,
      suggestedBy: current.selfName || 'Someone'
    }
    if (current.role === 'host') {
      current.queue = applyQueueEvent(current.queue, event)
      broadcastQueue()
    } else {
      partyBroadcast(encryptMessage(current.secret, event))
    }
    return { ok: true }
  })

  handle<PartyChatArgs, { ok: true; chat: PartyChatMessage }>(
    MEDIA_HUB_CHANNELS.partyChat,
    (_e, payload) => {
      const current = party
      if (!current) throw new Error('Join a room before sending a message.')
      const text = String(payload?.text || '')
        .trim()
        .slice(0, 1000)
      if (!text) throw new Error('Write a message before sending it.')
      const senderId = current.role === 'host' ? current.hostId : current.selfId
      if (!senderId) throw new Error('Your room connection is still starting.')
      const chat: PartyChatMessage = {
        id: String(payload?.id || createMemberId()).slice(0, 80),
        senderId,
        senderName: String(current.selfName || 'Someone').slice(0, 40),
        text,
        sentAt:
          typeof payload?.sentAt === 'number' && Number.isFinite(payload.sentAt)
            ? payload.sentAt
            : Date.now()
      }
      partyBroadcast(encryptMessage(current.secret, { type: 'chat', chat }))
      // A direct host never receives its own broadcast, and relay echo timing
      // should not decide when a sent message appears in the UI.
      sendPartyEvent({ type: 'chat', chat })
      return { ok: true, chat }
    }
  )

  handle<string, { ok: true }>(MEDIA_HUB_CHANNELS.partyRemove, (_e, queueId) => {
    const current = party
    if (!current) throw new Error('You are not in a party.')
    if (current.role !== 'host') throw new Error('Only the host can remove suggestions.')
    const event: PartyQueueEvent = { type: 'remove', queueId: String(queueId || '') }
    current.queue = applyQueueEvent(current.queue, event)
    broadcastQueue()
    return { ok: true }
  })

  handle<PartyVoteArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyVote, (_e, payload) => {
    const current = party
    if (!current) throw new Error('You are not in a party.')
    const { queueId, direction } = payload || {}
    const dir = Number(direction)
    if (dir !== 1 && dir !== -1) throw new Error('Invalid vote.')
    const voterId = current.role === 'host' ? current.hostId : current.selfId
    if (!voterId) throw new Error('Still connecting to the party — try again in a moment.')
    const event: PartyQueueEvent = {
      type: 'vote',
      queueId: String(queueId || ''),
      voterId,
      direction: dir
    }
    if (current.role === 'host') {
      current.queue = applyQueueEvent(current.queue, event)
      broadcastQueue()
    } else {
      partyBroadcast(encryptMessage(current.secret, event))
    }
    return { ok: true }
  })

  handle(MEDIA_HUB_CHANNELS.partyQueue, () => ({ queue: party?.queue || [] }))

  // Host-only, and deliberately fire-and-forget from the renderer's point
  // of view: this goes out BEFORE the host has resolved anything, so it
  // must not be able to delay or fail the host's own playback start. Same
  // explicit per-field copy as nowPlaying below — this is re-serialized
  // straight onto the network, so only the fields followers actually need
  // to render a "loading" card ever leave this process.
  handle<PartyPreparingArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyPreparing, (_e, payload) => {
    const current = party
    if (!current || current.role !== 'host')
      throw new Error('Only the host can start party playback.')
    const item = payload?.item
    const event = item
      ? {
          type: 'preparing' as const,
          item: {
            id: String(item.id || ''),
            type: String(item.type || ''),
            title: String(item.title || ''),
            poster: String(item.poster || '')
          }
        }
      : { type: 'preparing-cancelled' as const }
    partyBroadcast(encryptMessage(current.secret, event))
    return { ok: true }
  })

  handle<PartyNowPlayingArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyNowPlaying, (_e, payload) => {
    const current = party
    if (!current || current.role !== 'host')
      throw new Error('Only the host can start party playback.')
    const p = payload || {}
    const event = {
      type: 'nowPlaying' as const,
      infoHash: String(p.infoHash || ''),
      sources: Array.isArray(p.sources) ? p.sources.slice(0, 20) : [],
      mediaId: String(p.mediaId || ''),
      item: {
        id: p.item?.id,
        type: p.item?.type,
        title: p.item?.title,
        poster: p.item?.poster || ''
      },
      season: Number.isFinite(p.season) ? p.season : undefined,
      episode: Number.isFinite(p.episode) ? p.episode : undefined,
      position: Number(p.position) || 0
    }
    partyBroadcast(encryptMessage(current.secret, event))
    return { ok: true }
  })

  handle<PartyPlaybackActionArgs, { ok: boolean }>(
    MEDIA_HUB_CHANNELS.partyPlaybackAction,
    (_e, payload) => {
      const current = party
      if (!current) return { ok: false }
      const action = payload || {}
      // seek-sync/seek-waiting/seek-go are the host-coordinated seek-quorum
      // flow (see PlaybackOverlay's checkPartySeekReady/handleSeek) — only
      // the host ever initiates that flow, so those three stay host-only
      // here. Plain 'seek' is NOT part of that group: it's the ordinary
      // broadcast a member sends after allowMemberControl lets them control
      // playback locally (see PlaybackOverlay's seekToTarget), and the
      // actual permission check for it is enforced host-side, on receipt,
      // in handlePartyMessage's `!current.allowMemberControl` gate — not
      // here on the sender. Blocking it here too (as this used to) meant a
      // member's seek could never even reach the host, silently defeating
      // "Anyone can control playback" for seeking specifically. 'ready' is
      // the one message in this group any party member can send (a client
      // reporting its own buffer is ready).
      // The host's own presence can't arrive by message — nothing echoes
      // back to its sender — so it's applied to its own roster entry here.
      if (action.type === 'watching' && current.role === 'host') {
        const self = current.members.get(current.hostId)
        if (self) self.watching = action.watching === true
        broadcastPartyState()
        return { ok: true }
      }
      if (
        (action.type === 'seek-sync' ||
          action.type === 'seek-waiting' ||
          action.type === 'seek-go') &&
        current.role !== 'host'
      ) {
        throw new Error('Only the host can control party seeking.')
      }
      // Explicit per-field pass-through (not a blind spread of `action`)
      // — this gets re-serialized straight onto the network to every
      // other party member, so only the fields each message type
      // actually needs ever leave this process.
      const event: Record<string, unknown> = { type: action.type }
      if (typeof action.watching === 'boolean') event.watching = action.watching
      if (typeof action.paused === 'boolean') event.paused = action.paused
      if (Number.isFinite(action.position)) event.position = Number(action.position)
      if (typeof action.requestId === 'string') event.requestId = action.requestId
      if (Array.isArray(action.waitingIds)) event.waitingIds = action.waitingIds.map(String)
      partyBroadcast(encryptMessage(current.secret, event))
      return { ok: true }
    }
  )

  handle<PartySyncConnectArgs, ConnectResult>(
    MEDIA_HUB_CHANNELS.partySyncConnect,
    async (_e, payload) => {
      const { url, inviteKey } = payload || {}
      const trimmedUrl = String(url || '')
        .trim()
        .replace(/\/+$/, '')
      const key = String(inviteKey || '').trim()
      if (!trimmedUrl || !key) {
        return { ok: false, message: 'Enter the R3-Party-Sync worker URL and your invite key.' }
      }
      let parsedUrl: URL
      try {
        parsedUrl = new URL(trimmedUrl)
      } catch {
        return { ok: false, message: 'That is not a valid URL.' }
      }
      if (parsedUrl.protocol !== 'https:') {
        return { ok: false, message: 'The worker URL must be HTTPS.' }
      }
      try {
        await fetchJson(`${trimmedUrl}/host`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inviteKey: key })
        })
        const s = readSettings()
        s.partySyncUrl = trimmedUrl
        s.partySyncInviteKey = encrypt(key)
        writeSettings(s)
        return { ok: true, message: 'R3-Party-Sync connected.' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handle(MEDIA_HUB_CHANNELS.partySyncDisconnect, () => {
    const s = readSettings()
    delete s.partySyncUrl
    delete s.partySyncInviteKey
    writeSettings(s)
    return { ok: true }
  })
}
