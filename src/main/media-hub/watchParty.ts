// Ported from r3v07v3r-media-hub's src/main.cjs (the Watch Party section:
// getLocalLanIp, partyMemberSummaries, partyBroadcast, broadcastPartyState,
// broadcastQueue, handlePartyMessage, closeParty, connectPartyWs,
// connectRelayWs, and every `party:*`/`party-sync:*` handler), since
// reshaped around ONE hosting posture instead of a chosen mode: a host
// always listens directly and additionally attaches to the R3-Party-Sync
// relay when one is configured, minting a single invite code that carries
// every way in (see PartyStateHost). `PartyState` is a discriminated union
// on `role` so the compiler enforces exactly which fields exist for a host
// versus a client.
//
// Direct/LAN/WAN connections speak a small custom WebSocket protocol
// (hello/welcome/leave/party-state/queue-sync, all AES-256-GCM encrypted
// via party.ts's encryptMessage/decryptMessage with a per-party shared
// secret) directly to peers. Relay connections speak the same encrypted
// payloads, but wrapped in an unencrypted `{type:'relay', connId, isHost,
// body}` envelope produced by the external R3-Party-Sync worker. Do not
// change either wire format — it must keep interoperating with the
// original CommonJS app's install base and with the relay worker's
// existing protocol; the hybrid host BRIDGES the two (forwardFromMember)
// rather than altering either.

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
  PartyNowPlayingSummary,
  PartyQueueEntry,
  PartyStatusResult
} from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  applyQueueEvent,
  createMemberId,
  decodeShareCode,
  encodeHybridShareCode,
  encodeShareCode,
  encryptMessage,
  decryptMessage,
  type PartyLanEndpoint,
  type PartyQueueEvent,
  type PartyRelayEndpoint
} from './party'
import { encrypt, partySyncCredentials, readSettings, writeSettings } from './settingsStore'
import { currentPlaybackForParty } from './playerBridge'
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
  /** Which transport this member arrived over. Direct members each have
   *  their own inbound ws below; relay members are all reached through the
   *  single relay attachment, whose worker fans a send out to every relay
   *  connection — so forwarding a relay member's message back to the relay
   *  would duplicate it for its whole side. See forwardFromMember. */
  via: 'direct' | 'relay'
  ws?: WebSocket | null
}

/** The full nowPlaying event as broadcast — kept verbatim so a late joiner
 *  can be handed exactly what everyone else was. */
type PartyNowPlayingEvent = Record<string, unknown> & {
  type: 'nowPlaying'
  item: { id?: string; type?: string; title?: string; poster?: string }
  position: number
}

/**
 * A HOST always listens directly, and additionally attaches to the
 * R3-Party-Sync relay when one is configured — there is no mode choice any
 * more. One invite code carries every way in (see encodeHybridShareCode),
 * and each joiner simply uses the first transport that reaches the host:
 * direct when the network allows it, relay otherwise. The host bridges the
 * two sides (see forwardFromMember), so a LAN member and a remote member
 * are in the same party without either knowing the difference.
 */
interface PartyStateHost {
  role: 'host'
  wss: WebSocketServer
  port: number
  upnpStop?: () => void
  relay: { ws: WebSocket; url: string; roomId: string } | null
  /** The relay room's host credentials, kept for RECONNECTING: the hybrid
   *  invite names this exact roomId, so a dropped relay socket must come
   *  back to the SAME room or the code's relay door leads to a party with
   *  no host in it. Null when no relay was ever attached. */
  relayCreds: { url: string; roomId: string; roomToken: string } | null
  relayReattempts: number
  relayReattachTimer?: NodeJS.Timeout
  /** The invite code minted at host time — republished to rooms so a
   *  member's "Watch" button can join without the request round trip. */
  code: string
  secret: string
  members: Map<string, PartyHostMember>
  hostId: string
  selfName: string
  hostName: string
  queue: PartyQueueEntry[]
  allowMemberControl: boolean
  /** What the party is currently watching, for LATE JOINERS: stored when
   *  the host announces it and replayed to every member that arrives
   *  after. Without this, joining a film already in progress put someone
   *  in the chat with no picture and no way to ask for one — the exact
   *  live report that prompted it. Cleared when the host's own player
   *  closes (the 'watching: false' self-report). */
  nowPlaying: PartyNowPlayingEvent | null
  /** True between `preparing` (the host picked the NEXT title) and its
   *  nowPlaying (or preparing-cancelled). The stored nowPlaying still
   *  names the OUTGOING title for that whole window, so late-join replay
   *  and resync answers are suppressed — a member admitted mid-switch
   *  would otherwise be sent title A, start resolving it, and race B's
   *  announcement that is seconds away. They get B's broadcast like
   *  everyone else. */
  preparing: boolean
}

interface PartyStateClient {
  role: 'client'
  /** Which transport this client's single connection uses. */
  mode: PartyMode
  ws: WebSocket
  secret: string
  members: PartyMemberSummary[]
  selfName: string
  hostName: string
  selfId: string
  queue: PartyQueueEntry[]
  allowMemberControl: boolean
  /** Mirror of the host's nowPlaying summary, from party-state broadcasts —
   *  what lets the hub offer "Join the film" to someone who closed their
   *  player but stayed in the party. */
  nowPlaying: PartyNowPlayingSummary | null
}

type PartyState = PartyStateHost | PartyStateClient

let party: PartyState | null = null

/** The invite code of the party this app is currently hosting, or null.
 *  rooms.ts folds this into the activity announcement so room members can
 *  join the film in one click — see announceRoom. */
export function currentPartyJoinCode(): string | null {
  return party?.role === 'host' ? party.code : null
}

function nowPlayingSummary(current: PartyState): PartyNowPlayingSummary | null {
  if (current.role !== 'host') return current.nowPlaying
  const item = current.nowPlaying?.item
  if (!item?.id || !item.type) return null
  return {
    id: String(item.id),
    type: String(item.type),
    title: String(item.title || ''),
    poster: String(item.poster || '')
  }
}

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
  if (current.role === 'host') {
    // Both transports, every time: each direct member has its own socket,
    // and one send to the relay reaches every relay member (the worker
    // fans it out, and never echoes to this sender).
    for (const m of current.members.values()) {
      if (m.ws && m.ws.readyState === WebSocket.OPEN) m.ws.send(payload)
    }
    if (current.relay && current.relay.ws.readyState === WebSocket.OPEN) {
      current.relay.ws.send(payload)
    }
    return
  }
  if (current.ws && current.ws.readyState === WebSocket.OPEN) current.ws.send(payload)
}

/**
 * Re-forwards one member's message to every OTHER member, across both
 * transports. The asymmetry is the whole function: a relay member's message
 * was already fanned out to the rest of the relay side by the worker, so it
 * only needs bridging to the direct side — sending it back to the relay
 * would deliver it twice over there. A direct member's message reached only
 * this host, so it goes to every other direct socket AND once to the relay.
 */
function forwardFromMember(fromId: string, payload: string): void {
  const current = party
  if (!current || current.role !== 'host') return
  const senderVia = current.members.get(fromId)?.via
  for (const [id, m] of current.members) {
    if (id !== fromId && m.ws && m.ws.readyState === WebSocket.OPEN) m.ws.send(payload)
  }
  if (senderVia !== 'relay' && current.relay && current.relay.ws.readyState === WebSocket.OPEN) {
    current.relay.ws.send(payload)
  }
}

/** Hands a payload to ONE member, whichever side they joined from. A relay
 *  member can't be addressed individually — the worker fans out — so their
 *  copy goes out as a broadcast, which every other member must therefore
 *  treat idempotently (the nowPlaying replay is deduped follower-side by
 *  "am I already playing this"). */
function sendToMember(member: PartyHostMember, payload: string): void {
  const current = party
  if (!current || current.role !== 'host') return
  if (member.via === 'direct') {
    if (member.ws && member.ws.readyState === WebSocket.OPEN) member.ws.send(payload)
    return
  }
  if (current.relay && current.relay.ws.readyState === WebSocket.OPEN) {
    current.relay.ws.send(payload)
  }
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
  // The nowPlaying SUMMARY rides on every roster broadcast, so a member who
  // closed their player (or joined into silence) always knows whether there
  // is a film to come back to — that is what the hub's "Join the film"
  // button renders from. The full replayable event stays host-side.
  const nowPlaying = nowPlayingSummary(current)
  const payload = encryptMessage(current.secret, {
    type: 'party-state',
    members,
    allowMemberControl: current.allowMemberControl,
    nowPlaying
  })
  partyBroadcast(payload)
  sendPartyEvent({
    type: 'party-state',
    members,
    allowMemberControl: current.allowMemberControl,
    nowPlaying
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
    // The host bridges a member's message to whichever members its own
    // transport didn't already reach — see forwardFromMember.
    if (current?.role === 'host') {
      forwardFromMember(fromId, encryptMessage(current.secret, { type: 'chat', chat }))
    }
    sendPartyEvent({ type: 'chat', chat })
    return
  }
  // A member asking to be caught up — the hub's "Join the film" button.
  // Answered with the same stored event a fresh joiner is handed; every
  // OTHER member deduplicates it as "already playing this" (see the
  // follower unwrap in AppStateContext), which is what makes the relay
  // side's broadcast-only addressing safe here.
  if (current?.role === 'host' && msg?.type === 'resync-request') {
    const member = current.members.get(fromId)
    // Same preparing guard as admit: mid-title-change the stored event
    // names the outgoing title, and the asker will get the new one's
    // broadcast within seconds anyway.
    if (member && current.nowPlaying && !current.preparing) {
      sendToMember(member, encryptMessage(current.secret, current.nowPlaying))
    }
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
  if (current?.role === 'host') {
    forwardFromMember(fromId, encryptMessage(current.secret, { ...msg, from: fromId }))
  }
  sendPartyEvent({ type: 'message', from: fromId, message: msg })
}

/** Tears down the active party (host: closes the ws server/all member sockets and stops any UPnP mapping; client/relay-host: sends a best-effort `leave` then closes its socket) and clears `party`. Called both from `party:leave` and from `app.on('before-quit', ...)` in src/main/index.ts. */
export function closeParty(): void {
  const current = party
  if (!current) return
  if (current.role === 'host') {
    // The reattach loop must die with the party, or it would reconnect a
    // host socket to a room nobody is hosting any more.
    if (current.relayReattachTimer) {
      clearTimeout(current.relayReattachTimer)
      current.relayReattachTimer = undefined
    }
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
    if (current.relay) {
      try {
        current.relay.ws.send(encryptMessage(current.secret, { type: 'leave' }))
      } catch {
        // best-effort
      }
      try {
        current.relay.ws.close()
      } catch {
        // best-effort
      }
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
  /** Extra query params — the membership credentials rooms present. */
  query?: Record<string, string>
  WebSocketImpl?: typeof WebSocket
}

/** Shared with rooms.ts, which opens long-lived connections to room
 *  channels using exactly the same relay protocol. */
export function connectRelayWs(
  relayUrl: string,
  roomId: string,
  {
    token = '',
    secret = '',
    helloName = '',
    query = {},
    WebSocketImpl = WebSocket
  }: ConnectRelayOptions = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Membership rooms present their relay credentials here — the
    // admission cryptogram and joinSecret ride as query params exactly
    // like the host token always has, because a WebSocket upgrade has
    // nowhere better.
    const params = new URLSearchParams()
    if (token) params.set('token', token)
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value)
    }
    const search = params.toString()
    const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/party/${encodeURIComponent(roomId)}${
      search ? `?${search}` : ''
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
  /** Accepted and ignored: hosting always opens every transport now. Kept
   *  so an older renderer bundle calling with a mode cannot fail. */
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
    if (party) throw new Error('You are already in a watch party. Leave it first.')
    const { name: rawName } = payload || {}
    const name =
      String(rawName || 'Host')
        .trim()
        .slice(0, 40) || 'Host'

    // No transport choice any more: the direct listener always opens, the
    // relay attaches whenever R3-Party-Sync is configured, and ONE invite
    // code carries every way in. Each joiner uses the first transport that
    // reaches this host — a client on the same network never pays for a
    // round trip through the worker, and one across the internet still
    // gets in. The picker this replaces made the person answer a question
    // ("Direct or Relay?") whose right answer depends on where each FUTURE
    // joiner happens to be, which is exactly the thing nobody can know at
    // hosting time.
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
    members.set(hostId, { id: hostId, name, isHost: true, via: 'direct', ws: null })
    const hostState: PartyStateHost = {
      role: 'host',
      wss,
      port,
      relay: null,
      relayCreds: null,
      relayReattempts: 0,
      code: '',
      secret,
      members,
      hostId,
      selfName: name,
      hostName: name,
      queue: [],
      allowMemberControl: false,
      nowPlaying: null,
      preparing: false
    }
    party = hostState

    // A party created around a film ALREADY PLAYING — "Start a Watch Party"
    // from an in-progress title, or a room member's join request — is born
    // knowing its film, at the LIVE playhead. Both of the announcement's
    // usual sources are absent here: startPartyPlayback fires only when a
    // host starts a title (which happened before this party existed), and
    // the position heartbeat can update a stored nowPlaying but never
    // create one. Seeded in main because main owns both facts (the session
    // identity and the observed time-pos); the renderer paths need no
    // seeding of their own.
    const playing = currentPlaybackForParty()
    if (playing) {
      const media = playing.media
      hostState.nowPlaying = {
        type: 'nowPlaying',
        infoHash: '',
        sources: [],
        // Same coordinate format the renderer's buildMediaId produces —
        // torbox.ts's play:stream parses it back out on the follower side.
        mediaId:
          media.kind === 'movie'
            ? media.id
            : `${media.id}:${media.seasonNumber ?? 1}:${media.episodeNumber ?? 1}`,
        item: {
          id: media.id,
          type: media.kind,
          title: media.title,
          poster: media.posterUrl || ''
        },
        season: media.seasonNumber,
        episode: media.episodeNumber,
        position: playing.positionSeconds
      }
    }

    // Everything a newcomer must be told, whichever door they came in by.
    // The roster broadcast was always here; the nowPlaying replay is the
    // fix for the live report "joining put me in the chat but not the
    // film" — a title that started before this member existed was never
    // announced to them, and nothing else ever would.
    const admit = (member: PartyHostMember): void => {
      broadcastPartyState()
      // Not while a title change is in flight: the stored event still names
      // the OUTGOING title — see PartyStateHost.preparing.
      if (hostState.nowPlaying && !hostState.preparing) {
        sendToMember(member, encryptMessage(secret, hostState.nowPlaying))
      }
    }

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
          const member: PartyHostMember = {
            id: memberId,
            name: String(msg.name || 'Guest').slice(0, 40) || 'Guest',
            isHost: false,
            via: 'direct',
            ws
          }
          members.set(memberId, member)
          ws.send(encryptMessage(secret, { type: 'welcome', id: memberId }))
          admit(member)
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
    if (mapping && party === hostState) {
      hostState.upnpStop = mapping.stop
    }

    // The relay attachment is BEST-EFFORT: a worker that is down or
    // misconfigured costs the party its across-the-internet door, not its
    // existence. Attached after the direct listener so a failure here can
    // never take down what already works.
    const wireRelayWs = (relayWs: WebSocket, { reconcile = false } = {}): void => {
      // A RECONNECT has to reconcile the relay roster it kept through the
      // outage. The members' own sockets to the worker never dropped (the
      // blip was on this side), so they will not say hello again — they
      // are simply still there, which is why the close handler below keeps
      // them. The authority on who is still there is the WORKER's `peers`
      // envelope (sent on connect, listing every live connection): the
      // retained replay cannot be it, because the worker omits frames older
      // than ten minutes, and a quiet member's only frame is often the
      // hello it sent long ago — live on the socket, invisible in the
      // replay. Against an older worker that sends no `peers`, nothing is
      // pruned at all: a lingering ghost is recoverable, an evicted live
      // member is not.
      let pendingReconcile = reconcile
      relayWs.on('message', (raw) => {
        let envelope: {
          type?: string
          connId?: string
          body?: string
          isHost?: boolean
          connIds?: unknown
        }
        try {
          envelope = JSON.parse(raw.toString())
        } catch {
          return
        }
        const fromId = String(envelope.connId || '')
        if (envelope.type === 'peers') {
          if (!pendingReconcile) return
          pendingReconcile = false
          const alive = new Set(
            (Array.isArray(envelope.connIds) ? envelope.connIds : []).map(String)
          )
          for (const [id, member] of members) {
            if (member.via === 'relay' && !alive.has(id)) members.delete(id)
          }
          // Broadcast regardless of whether anything was pruned: it also
          // delivers the roster to members re-admitted from retained
          // hellos below.
          broadcastPartyState()
          return
        }
        if (envelope.type === 'retained') {
          // A retained hello is a member who joined (and stayed quiet)
          // while this host was away: admit them by name, with NO
          // nowPlaying replay — ageMs on a retained frame means they have
          // been in the party for a while.
          if (!fromId) return
          const msg = decryptMessage(secret, envelope.body || '') as PartyMessage | null
          if (msg?.type === 'hello' && !members.has(fromId) && members.size < MAX_PARTY_MEMBERS) {
            members.set(fromId, {
              id: fromId,
              name: String(msg.name || 'Guest').slice(0, 40) || 'Guest',
              isHost: false,
              via: 'relay'
            })
          }
          return
        }
        if (envelope.type !== 'relay' || !fromId) return
        const msg = decryptMessage(secret, envelope.body || '') as PartyMessage | null
        if (!msg) return
        if (msg.type === 'hello') {
          if (!members.has(fromId) && members.size >= MAX_PARTY_MEMBERS) return
          const member: PartyHostMember = {
            id: fromId,
            name: String(msg.name || 'Guest').slice(0, 40) || 'Guest',
            isHost: false,
            via: 'relay'
          }
          members.set(fromId, member)
          admit(member)
          return
        }
        if (msg.type === 'leave') {
          if (members.delete(fromId)) broadcastPartyState()
          return
        }
        if (!members.has(fromId)) {
          // A valid decrypt IS the membership credential — AES-GCM under
          // the party secret authenticates, so only someone holding the
          // invite can produce this frame. Reaching here unknown means the
          // roster lost them (a reconnect against an older worker with no
          // `peers` support, a hello this host never saw): re-admit rather
          // than silently discarding everything they say. The name arrives
          // with nothing but their hello, so it degrades to Guest.
          if (members.size >= MAX_PARTY_MEMBERS) return
          members.set(fromId, { id: fromId, name: 'Guest', isHost: false, via: 'relay' })
          broadcastPartyState()
        }
        handlePartyMessage(fromId, msg)
      })
      relayWs.on('close', () => {
        // Losing the relay is losing ONE door, not the party — and only
        // the HOST's side of it: the members' own worker connections are
        // typically still up, so the roster is KEPT (dropping it stranded
        // them — apparently connected, but with a host that had forgotten
        // them and discarded their every message). The reconnect below
        // comes back to this exact room and reconciles who is really
        // still there; members who left during the outage are pruned then.
        if (party !== hostState || hostState.relay?.ws !== relayWs) return
        hostState.relay = null
        scheduleRelayReattach()
      })
    }

    const scheduleRelayReattach = (): void => {
      if (party !== hostState || !hostState.relayCreds || hostState.relayReattachTimer) return
      hostState.relayReattempts += 1
      // Quick first retries for a blip, then a steady 30s cadence for as
      // long as the party lives — the host regaining its network minutes
      // later should still restore the invite's relay door.
      const delay = [2000, 5000, 15000][hostState.relayReattempts - 1] ?? 30000
      hostState.relayReattachTimer = setTimeout(() => {
        hostState.relayReattachTimer = undefined
        void (async () => {
          const creds = hostState.relayCreds
          if (party !== hostState || hostState.relay || !creds) return
          try {
            // The SAME room, not a fresh POST /host: the invite already in
            // people's hands names this roomId.
            const relayWs = await connectRelayWs(creds.url, creds.roomId, {
              token: creds.roomToken
            })
            if (party !== hostState || hostState.relay) {
              relayWs.close()
              return
            }
            hostState.relay = { ws: relayWs, url: creds.url, roomId: creds.roomId }
            hostState.relayReattempts = 0
            wireRelayWs(relayWs, { reconcile: true })
          } catch (error) {
            logError('party:relay-reattach', error)
            scheduleRelayReattach()
          }
        })()
      }, delay)
    }

    const creds = partySyncCredentials()
    if (creds.url && creds.inviteKey && party === hostState) {
      try {
        const { roomId, roomToken } = await fetchJson<{ roomId: string; roomToken: string }>(
          `${creds.url}/host`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inviteKey: creds.inviteKey })
          }
        )
        const relayWs = await connectRelayWs(creds.url, roomId, { token: roomToken })
        // The party can have been left during the awaits above.
        if (party !== hostState) {
          relayWs.close()
        } else {
          hostState.relay = { ws: relayWs, url: creds.url, roomId }
          hostState.relayCreds = { url: creds.url, roomId, roomToken }
          wireRelayWs(relayWs)
        }
      } catch (error) {
        logError('party:relay-attach', error)
      }
    }

    const code =
      party === hostState && hostState.relay
        ? encodeHybridShareCode({
            lan,
            wan,
            relay: { url: hostState.relay.url, roomId: hostState.relay.roomId },
            secret
          })
        : encodeShareCode({ lan, wan, secret })
    hostState.code = code
    return {
      ok: true,
      code,
      port,
      wanAvailable: Boolean(wan),
      relayAttached: Boolean(hostState.relay)
    }
  })

  handle<PartyJoinArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyJoin, async (_e, payload) => {
    if (party) throw new Error('You are already in a watch party. Leave it first.')
    const { code, name } = payload || {}
    const parsed = decodeShareCode(code)
    if (!parsed) throw new Error('That watch party code is invalid.')
    // A v4 code is a ROOM invite, not a watch party. Connecting to it here
    // would technically work — same relay, same crypto — and would leave
    // the person sitting silently in a presence channel wondering why no
    // film starts. Saying which kind of code it is beats pretending.
    if (parsed.v === 4) {
      throw new Error('That is a room code — join it from Rooms, then join a member from there.')
    }
    const displayName =
      String(name || 'Guest')
        .trim()
        .slice(0, 40) || 'Guest'

    // Both handlers store the client's party-state exactly the same way;
    // only the framing differs (raw messages direct, worker envelopes over
    // the relay).
    const applyPartyState = (msg: PartyMessage): void => {
      const members = (msg.members as PartyMemberSummary[]) || []
      const allowMemberControl = Boolean(msg.allowMemberControl)
      const nowPlaying = (msg.nowPlaying as PartyNowPlayingSummary | null | undefined) ?? null
      if (party?.role === 'client') {
        party.members = members
        party.allowMemberControl = allowMemberControl
        party.nowPlaying = nowPlaying
        // The share code no longer carries the host's name, so this
        // broadcast is where a joiner learns it.
        party.hostName = members.find((m) => m.isHost)?.name || party.hostName
      }
      sendPartyEvent({ type: 'party-state', members, allowMemberControl, nowPlaying })
    }

    const joinRelayParty = async (relay: PartyRelayEndpoint, secret: string): Promise<void> => {
      const ws = await connectRelayWs(relay.url, relay.roomId, {
        secret,
        helloName: displayName
      })
      const clientRelayState: PartyStateClient = {
        role: 'client',
        mode: 'relay',
        ws,
        secret,
        members: [],
        selfName: displayName,
        hostName: parsed.name || '',
        selfId: '',
        queue: [],
        allowMemberControl: false,
        nowPlaying: null
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
        // parties. It exists for room presence, where stale state is still
        // useful; replaying a minutes-old message into live playback would
        // be actively wrong. Late joiners are caught up by the HOST
        // instead: it stores its nowPlaying and replays it to every member
        // that arrives after (see admit in the host handler).
        if (envelope.type !== 'relay') return
        const msg = decryptMessage(secret, envelope.body || '') as PartyMessage | null
        if (!msg) return
        if (msg.type === 'party-state') {
          applyPartyState(msg)
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
    }

    // The WHOLE attempt — connect AND the encrypted welcome — is made per
    // endpoint. A socket `open` alone proves nothing about who answered
    // (a joiner's own LAN can have an unrelated WebSocket service on the
    // exact private address a stale invite names), and treating it as
    // success used to end the endpoint loop — so a dud LAN endpoint cost
    // the perfectly good WAN one its turn, and the relay after that.
    const joinDirectParty = async (
      endpoints: PartyLanEndpoint[],
      secret: string
    ): Promise<void> => {
      let lastError: unknown = null
      for (const endpoint of endpoints) {
        try {
          await joinDirectEndpoint(endpoint, secret)
          return
        } catch (error) {
          lastError = error
        }
      }
      throw new Error(
        lastError instanceof Error ? lastError.message : 'Could not reach the watch party host.'
      )
    }

    const joinDirectEndpoint = async (
      endpoint: PartyLanEndpoint,
      secret: string
    ): Promise<void> => {
      const connectedWs = await connectPartyWs(endpoint, secret, displayName)
      const clientDirectState: PartyStateClient = {
        role: 'client',
        mode: 'direct',
        ws: connectedWs,
        secret,
        members: [],
        selfName: displayName,
        hostName: parsed.name || '',
        selfId: '',
        queue: [],
        allowMemberControl: false,
        nowPlaying: null
      }
      party = clientDirectState
      // The transport is only CHOSEN once the host has actually answered.
      // A TCP+WebSocket `open` proves a socket accepted the upgrade, not
      // that it is this party's host: a stale LAN/WAN endpoint can now be
      // some other WebSocket service, which would 'succeed' here and leave
      // the working relay in a hybrid code untried, followed shortly by
      // host-disconnected. The encrypted `welcome` is the handshake only
      // the real host can produce (it holds the code's secret), so joining
      // waits for it — and a close or timeout before it arrives is a
      // failed ATTEMPT (thrown, so v5 falls back to the relay), never a
      // "host disconnected" event for a party this client was never in.
      let welcomed = false
      let settleWelcome: { resolve: () => void; reject: (error: Error) => void } | null = null
      const welcomePromise = new Promise<void>((resolve, reject) => {
        settleWelcome = { resolve, reject }
      })
      connectedWs.on('message', (raw) => {
        const msg = decryptMessage(secret, raw.toString()) as PartyMessage | null
        if (!msg) return
        if (msg.type === 'welcome') {
          if (party?.role === 'client') party.selfId = String(msg.id || '')
          welcomed = true
          settleWelcome?.resolve()
          return
        }
        if (msg.type === 'party-state') {
          applyPartyState(msg)
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
        if (!welcomed) {
          settleWelcome?.reject(new Error('The host closed the connection before answering.'))
          if (party === clientDirectState) party = null
          return
        }
        if (party?.role === 'client') {
          party = null
          sendPartyEvent({ type: 'host-disconnected' })
        }
      })
      const timer = setTimeout(
        () => settleWelcome?.reject(new Error('The host did not answer the handshake.')),
        6000
      )
      try {
        await welcomePromise
      } catch (error) {
        if (party === clientDirectState) party = null
        try {
          connectedWs.close()
        } catch {
          // best-effort
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    if (parsed.v === 2) {
      await joinRelayParty(parsed.relay, parsed.secret)
      return { ok: true }
    }
    if (parsed.v === 5) {
      // Direct first — a socket on the same network beats a round trip
      // through the worker for every message of the whole session, and the
      // attempts are cheap (5s per endpoint). The relay is the fallback
      // that makes the same code work from across the internet.
      const endpoints = [parsed.lan, parsed.wan].filter((endpoint): endpoint is PartyLanEndpoint =>
        Boolean(endpoint)
      )
      try {
        await joinDirectParty(endpoints, parsed.secret)
      } catch {
        await joinRelayParty(parsed.relay, parsed.secret)
      }
      return { ok: true }
    }
    const endpoints = [parsed.lan, parsed.wan].filter((endpoint): endpoint is PartyLanEndpoint =>
      Boolean(endpoint)
    )
    await joinDirectParty(endpoints, parsed.secret)
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
      // A host always listens directly (the relay, when attached, is an
      // additional door rather than a mode) — see the host handler.
      mode: current.role === 'host' ? 'direct' : current.mode,
      members: partyMemberSummaries(),
      selfId: current.role === 'host' ? current.hostId : current.selfId || '',
      selfName: current.selfName || '',
      hostName: current.hostName || '',
      allowMemberControl: Boolean(current.allowMemberControl),
      nowPlaying: nowPlayingSummary(current)
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
      if (!current) throw new Error('You are not in a watch party.')
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
    if (!current) throw new Error('You are not in a watch party.')
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
      if (!current) throw new Error('Join a watch party before sending a message.')
      const text = String(payload?.text || '')
        .trim()
        .slice(0, 1000)
      if (!text) throw new Error('Write a message before sending it.')
      const senderId = current.role === 'host' ? current.hostId : current.selfId
      if (!senderId) throw new Error('Your watch party connection is still starting.')
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
    if (!current) throw new Error('You are not in a watch party.')
    if (current.role !== 'host') throw new Error('Only the host can remove suggestions.')
    const event: PartyQueueEvent = { type: 'remove', queueId: String(queueId || '') }
    current.queue = applyQueueEvent(current.queue, event)
    broadcastQueue()
    return { ok: true }
  })

  handle<PartyVoteArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyVote, (_e, payload) => {
    const current = party
    if (!current) throw new Error('You are not in a watch party.')
    const { queueId, direction } = payload || {}
    const dir = Number(direction)
    if (dir !== 1 && dir !== -1) throw new Error('Invalid vote.')
    const voterId = current.role === 'host' ? current.hostId : current.selfId
    if (!voterId) throw new Error('Still connecting to the watch party — try again in a moment.')
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
      throw new Error('Only the host can start watch party playback.')
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
    // While the NEXT title resolves, the stored nowPlaying still names the
    // outgoing one — late-join replay stands down until the new
    // announcement (or the cancellation, which leaves the old title as the
    // honest answer again). See PartyStateHost.preparing.
    current.preparing = Boolean(item)
    partyBroadcast(encryptMessage(current.secret, event))
    return { ok: true }
  })

  handle<PartyNowPlayingArgs, { ok: true }>(MEDIA_HUB_CHANNELS.partyNowPlaying, (_e, payload) => {
    const current = party
    if (!current || current.role !== 'host')
      throw new Error('Only the host can start watch party playback.')
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
    // Kept for whoever arrives NEXT: the admit path replays this to late
    // joiners, and the roster broadcast below tells everyone already here
    // (the hub's "Join the film" button included) what is on. The
    // announcement is also what ends the preparing window it opened.
    current.nowPlaying = event as PartyNowPlayingEvent
    current.preparing = false
    broadcastPartyState()
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
        // The host's player closing is the end of "what this party is
        // watching" as far as late joiners are concerned: replaying a
        // title whose host has walked away would drag a newcomer into a
        // film nobody is steering.
        if (action.watching !== true) current.nowPlaying = null
        broadcastPartyState()
        return { ok: true }
      }
      // The host's own position heartbeat keeps the stored nowPlaying
      // honest, so a late joiner is dropped near the live playhead instead
      // of at where the film STARTED however long ago.
      if (
        current.role === 'host' &&
        current.nowPlaying &&
        action.type === 'position' &&
        Number.isFinite(action.position)
      ) {
        current.nowPlaying.position = Number(action.position)
      }
      if (
        (action.type === 'seek-sync' ||
          action.type === 'seek-waiting' ||
          action.type === 'seek-go') &&
        current.role !== 'host'
      ) {
        throw new Error('Only the host can control watch party seeking.')
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
