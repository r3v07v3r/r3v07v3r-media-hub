// Friends groups: a persistent, host-less presence channel.
//
// Deliberately built on exactly the same relay room a watch party uses —
// a group is just another room that everyone stays connected to, rather
// than a new server concept. That keeps the Durable Object what it
// already is (a dumb forwarder that never decrypts) and means group
// traffic is end-to-end encrypted with the group secret for free.
//
// HOST-LESS is the important design property. A watch party has a host
// who owns the member list and broadcasts party-state; a friends group
// cannot work that way, because the group has to keep functioning when
// any particular person is offline — including whoever created it. So
// nobody is authoritative: every member periodically announces itself,
// and every member independently builds its own view from what it hears.
// Presence is therefore soft state with a TTL, not a roster: a member who
// stops announcing simply ages out. That also makes crash//network-drop
// handling free — there is no "leave" that must be delivered for the
// group to stay correct.
//
// Activity ("watching Dune, 34 minutes in") rides the same announcement
// and is strictly opt-in: with sharing off, the field is simply absent,
// so a member who has not opted in is indistinguishable from one who is
// not watching anything.

import crypto from 'node:crypto'
import type WebSocket from 'ws'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { FriendPresence, FriendsStatus, FriendActivity } from '../../shared/media-hub/types'
import { decodeShareCode, encodeRelayShareCode, decryptMessage, encryptMessage } from './party'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import { partySyncCredentials, readSettings, writeSettings } from './settingsStore'
import { connectRelayWs } from './watchParty'

/** How often each member re-announces itself. Frequent enough that a new
 *  arrival sees everyone quickly, rare enough to be irrelevant for both
 *  bandwidth and Durable Object wake-ups. */
const ANNOUNCE_INTERVAL_MS = 20_000

/** A member not heard from within this window is dropped from the local
 *  view. Comfortably more than two announce intervals, so a single lost
 *  message or a brief stall never makes someone flicker offline. */
const PRESENCE_TTL_MS = 70_000

/** Reconnect backoff bounds. A friends group is meant to be always-on, so
 *  a dropped socket retries indefinitely rather than giving up — but it
 *  backs off so a worker outage doesn't turn every client into a hot loop. */
const RECONNECT_MIN_MS = 3_000
const RECONNECT_MAX_MS = 120_000

interface FriendsState {
  code: string
  relayUrl: string
  roomId: string
  secret: string
  ws: WebSocket | null
  /** Stable across restarts — see friendIdentity(). */
  friendId: string
  name: string
  /** What we last told the group we're watching, or null. */
  activity: FriendActivity | null
  presence: Map<string, FriendPresence & { lastSeen: number }>
  announceTimer: ReturnType<typeof setInterval> | null
  reapTimer: ReturnType<typeof setInterval> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
  closing: boolean
}

let state: FriendsState | null = null

/** A per-install identity that survives restarts. The relay's own connId
 *  changes on every connection, so it cannot be used to recognise the same
 *  friend twice — presence would show duplicates after any reconnect. */
function friendIdentity(): { friendId: string; name: string } {
  const settings = readSettings()
  let friendId = settings.friendId
  if (!friendId) {
    friendId = crypto.randomUUID()
    settings.friendId = friendId
    writeSettings(settings)
  }
  return { friendId, name: settings.partyDisplayName || 'Someone' }
}

function isSharingEnabled(): boolean {
  return readSettings().friendsShareActivity === true
}

function pushStatus(): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.friendsEvent, friendsStatus())
}

/** The local view: everyone heard from recently, self included so the UI
 *  can show the group as it appears to everyone else. */
export function friendsStatus(): FriendsStatus {
  if (!state) return { inGroup: false, friends: [], sharing: isSharingEnabled() }
  const now = Date.now()
  // lastSeen is local bookkeeping for the TTL and deliberately not part of
  // the renderer-facing shape.
  const friends: FriendPresence[] = [...state.presence.values()]
    .filter((p) => now - p.lastSeen <= PRESENCE_TTL_MS)
    .map((p) => ({ friendId: p.friendId, name: p.name, activity: p.activity }))
  return {
    inGroup: true,
    code: state.code,
    selfId: state.friendId,
    connected: state.ws !== null,
    sharing: isSharingEnabled(),
    friends
  }
}

function announce(): void {
  const current = state
  if (!current || !current.ws) return
  // Sharing off means the field is absent entirely, not null-with-a-flag:
  // "not sharing" and "not watching" should be indistinguishable to
  // everyone else.
  const payload: Record<string, unknown> = {
    type: 'friend-presence',
    friendId: current.friendId,
    name: current.name
  }
  if (isSharingEnabled() && current.activity) payload.activity = current.activity
  try {
    current.ws.send(encryptMessage(current.secret, payload))
  } catch {
    // A send failure is handled by the socket's own close/error path.
  }
}

/** Answer someone we haven't seen before, so they learn about us without
 *  waiting for our next scheduled announce.
 *
 *  Found by testing two clients: a member who joins an established group
 *  announces itself and is seen immediately, but sees NOBODY until every
 *  other member's next interval came around — up to ANNOUNCE_INTERVAL_MS
 *  of staring at an empty group. Replying to strangers closes that to a
 *  round trip. Debounced because a join into a large group would otherwise
 *  have everyone reply at once, and each of those replies is itself a
 *  stranger to nobody — one reply per burst is enough. */
let replyTimer: ReturnType<typeof setTimeout> | null = null
function replyToNewcomer(): void {
  if (replyTimer) return
  replyTimer = setTimeout(() => {
    replyTimer = null
    announce()
  }, 400)
}

function recordPresence(msg: Record<string, unknown>): void {
  const current = state
  if (!current) return
  const friendId = String(msg.friendId || '')
  if (!friendId || friendId === current.friendId) return
  if (!current.presence.has(friendId)) replyToNewcomer()
  const activity = (msg.activity as FriendActivity | undefined) || null
  current.presence.set(friendId, {
    friendId,
    name: String(msg.name || 'Someone').slice(0, 40),
    activity: activity
      ? {
          mediaId: String(activity.mediaId || ''),
          kind: String(activity.kind || 'movie'),
          title: String(activity.title || '').slice(0, 120),
          poster: String(activity.poster || '').slice(0, 500),
          position: Number(activity.position) || 0,
          paused: activity.paused === true,
          // Whether this friend can be joined right now — carried so the
          // UI can offer "join their party" vs "just watch this too"
          // without a round trip.
          partyCode: activity.partyCode ? String(activity.partyCode).slice(0, 400) : undefined
        }
      : null,
    lastSeen: Date.now()
  })
  pushStatus()
}

function reap(): void {
  const current = state
  if (!current) return
  const now = Date.now()
  let changed = false
  for (const [id, p] of current.presence) {
    if (now - p.lastSeen > PRESENCE_TTL_MS) {
      current.presence.delete(id)
      changed = true
    }
  }
  if (changed) pushStatus()
}

function scheduleReconnect(): void {
  const current = state
  if (!current || current.closing || current.reconnectTimer) return
  const delay = current.reconnectDelay
  current.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(delay * 1.8))
  current.reconnectTimer = setTimeout(() => {
    if (!state) return
    state.reconnectTimer = null
    openSocket().catch(() => scheduleReconnect())
  }, delay)
}

async function openSocket(): Promise<void> {
  const current = state
  if (!current || current.closing) return
  const ws = await connectRelayWs(current.relayUrl, current.roomId, {})
  if (!state || state !== current) {
    try {
      ws.close()
    } catch {
      // superseded by a newer connect
    }
    return
  }
  current.ws = ws
  current.reconnectDelay = RECONNECT_MIN_MS
  ws.on('message', (raw: unknown) => {
    // Same relay envelope the party client already speaks: the worker wraps
    // each message as {type:'relay', body} and never decrypts the body.
    let body = String(raw)
    try {
      const envelope = JSON.parse(body) as { type?: string; body?: string }
      if (envelope?.type === 'relay' && typeof envelope.body === 'string') body = envelope.body
      else if (envelope?.type === 'assigned') return
    } catch {
      // not an envelope — fall through and try to decrypt as-is
    }
    const msg = decryptMessage(current.secret, body) as Record<string, unknown> | null
    if (msg && msg.type === 'friend-presence') recordPresence(msg)
  })
  const onGone = (): void => {
    if (!state || state !== current) return
    current.ws = null
    pushStatus()
    scheduleReconnect()
  }
  ws.on('close', onGone)
  ws.on('error', onGone)
  // Announce immediately so a reconnect doesn't leave us invisible for a
  // full interval, and so everyone already present learns about us at once.
  announce()
  pushStatus()
}

function startTimers(): void {
  const current = state
  if (!current) return
  current.announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
  current.reapTimer = setInterval(reap, 10_000)
}

function teardown(): void {
  const current = state
  if (!current) return
  current.closing = true
  if (current.announceTimer) clearInterval(current.announceTimer)
  if (current.reapTimer) clearInterval(current.reapTimer)
  if (current.reconnectTimer) clearTimeout(current.reconnectTimer)
  if (replyTimer) {
    clearTimeout(replyTimer)
    replyTimer = null
  }
  try {
    current.ws?.close()
  } catch {
    // best-effort
  }
  state = null
}

async function activate(code: string): Promise<void> {
  const parsed = decodeShareCode(code)
  if (!parsed || parsed.v !== 2) throw new Error('That is not a valid group code.')
  teardown()
  const { friendId, name } = friendIdentity()
  state = {
    code,
    relayUrl: parsed.relay.url,
    roomId: parsed.relay.roomId,
    secret: parsed.secret,
    ws: null,
    friendId,
    name,
    activity: null,
    presence: new Map(),
    announceTimer: null,
    reapTimer: null,
    reconnectTimer: null,
    reconnectDelay: RECONNECT_MIN_MS,
    closing: false
  }
  startTimers()
  await openSocket().catch((error) => {
    logError('friends:connect', String(error))
    scheduleReconnect()
  })
}

/** Called at startup so a saved group reconnects without anyone acting. */
export function restoreFriendsGroup(): void {
  const code = readSettings().friendsGroupCode
  if (!code) return
  activate(code).catch((error) => logError('friends:restore', String(error)))
}

/** Publishes (or clears) what this member is watching. Cheap and
 *  idempotent — the renderer calls it as playback state changes, and it
 *  only actually reaches the network on the next announce, or immediately
 *  if the title itself changed. */
export function setFriendsActivity(activity: FriendActivity | null): void {
  const current = state
  if (!current) return
  const changedTitle = (current.activity?.mediaId || '') !== (activity?.mediaId || '')
  current.activity = activity
  if (changedTitle) announce()
}

export function registerFriendsIpc(): void {
  handle(MEDIA_HUB_CHANNELS.friendsStatus, () => friendsStatus())

  handle<{ name?: string } | undefined, { ok: true; code: string }>(
    MEDIA_HUB_CHANNELS.friendsCreate,
    async () => {
      const creds = partySyncCredentials()
      if (!creds.url || !creds.inviteKey) {
        throw new Error('Configure R3-Party-Sync in Settings first.')
      }
      // A group room is created exactly like a party room. The roomToken
      // that comes back is the HOST token; a friends group has no host, so
      // it is deliberately discarded — every member connects as an ordinary
      // participant and nobody gets privileged treatment from the relay.
      const response = await fetch(`${creds.url}/host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteKey: creds.inviteKey })
      })
      if (!response.ok) throw new Error(`The party-sync worker refused: ${response.status}`)
      const { roomId } = (await response.json()) as { roomId: string }
      const secret = crypto.randomBytes(24).toString('base64url')
      const code = encodeRelayShareCode({ relay: { url: creds.url, roomId }, secret, name: '' })
      const settings = readSettings()
      settings.friendsGroupCode = code
      writeSettings(settings)
      await activate(code)
      pushStatus()
      return { ok: true, code }
    }
  )

  handle<{ code?: string }, { ok: true }>(MEDIA_HUB_CHANNELS.friendsJoin, async (_e, payload) => {
    const code = String(payload?.code || '').trim()
    if (!code) throw new Error('Enter a group code.')
    await activate(code)
    const settings = readSettings()
    settings.friendsGroupCode = code
    writeSettings(settings)
    pushStatus()
    return { ok: true }
  })

  handle(MEDIA_HUB_CHANNELS.friendsLeave, () => {
    teardown()
    const settings = readSettings()
    delete settings.friendsGroupCode
    writeSettings(settings)
    pushStatus()
    return { ok: true }
  })

  handle<{ sharing?: boolean }, { ok: true }>(
    MEDIA_HUB_CHANNELS.friendsSetSharing,
    (_e, payload) => {
      const settings = readSettings()
      settings.friendsShareActivity = payload?.sharing === true
      writeSettings(settings)
      // Announce straight away so turning sharing off withdraws what we
      // already published rather than leaving it visible for an interval.
      announce()
      pushStatus()
      return { ok: true }
    }
  )

  handle<{ activity?: FriendActivity | null }, { ok: true }>(
    MEDIA_HUB_CHANNELS.friendsSetActivity,
    (_e, payload) => {
      setFriendsActivity(payload?.activity ?? null)
      return { ok: true }
    }
  )
}
