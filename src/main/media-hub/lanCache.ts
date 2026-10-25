// The app's client for a paired r3-cache daemon — tier 2 of the source
// order, between "already on this disk" and "on the Jellyfin server".
//
// Every call is best-effort by the same contract as mediaSources.ts: a
// daemon that is off, unreachable or mid-update degrades to "the tier
// contributes nothing", never to a playback error. The daemon is an
// optimisation the household added, not a dependency the app acquired.

import os from 'node:os'

import type {
  LanCacheCatalogResponse,
  LanCacheTitlesRefreshResponse,
  LanCacheTitlesResponse,
  LanCacheDevice,
  LanCacheDevicesResponse,
  LanCacheOwnItem,
  LanCachePairResponse,
  LanCacheUpdateNowResponse,
  LanCachePingResponse,
  LanCacheJobPayload,
  LanCacheStatusResponse
} from '../../shared/lancache/protocol'
import type { LanCacheAppEvent, StreamCandidate } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { electronModule } from './electronModule'
import { fetchJson, type HttpError } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import {
  clearLanCacheConnection,
  getLanCacheConnection,
  getTorBoxToken,
  isLanCacheAutoJoinOn,
  setLanCacheAutoJoin,
  setLanCacheConnection
} from './settingsStore'
import { findLanCaches, type DiscoveredLanCache } from './lanCacheDiscovery'

/** The update route answers only once the server has checked its release
 *  feed and staged the bundle, so it is not a sub-second call. Three
 *  minutes is generous for a LAN and still bounded — long enough not to
 *  call a working update a failure, short enough to stop waiting on a
 *  server that has gone away mid-download. */
const UPDATE_NOW_TIMEOUT_MS = 3 * 60 * 1000

/** How long the play-time lookup waits for the daemon. It is awaited before
 *  TorBox is tried, so httpClient's thirty-second default meant a paired
 *  daemon that drops packets (a laptop away from home) held the play click
 *  for half a minute. A daemon on the same network answers in well under a
 *  second; one that has not answered in three is treated as away, and the
 *  tier contributes nothing. The three seconds are counted from the call,
 *  not from dispatch: the 'lancache' lane holds four requests at a time, and
 *  the feeder, title sync and status calls to an away daemon each hold a
 *  slot for their own thirty seconds, so a wire timeout alone would start
 *  only after the lookup had queued behind them. */
export const LAN_LOOKUP_TIMEOUT_MS = 3_000

function request<T>(pathname: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const connection = getLanCacheConnection()
  if (!connection) throw new Error('No cache server is paired.')
  return fetchJson<T>(
    `${connection.url}${pathname}`,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${connection.token}`
      }
    },
    { lane: 'lancache', label: 'cache server', timeoutMs }
  )
}

/**
 * Whether there is a cache server this app may actually USE.
 *
 * A pending connection is deliberately false here. Its token is real but
 * authorises nothing until the server's administrator approves it, so
 * every source lookup and stream through it would 401 — and a tier that
 * fails on every call is worse than a tier that is switched off, because
 * it costs a round-trip per playback to learn the same thing.
 */
export function isLanCacheConnected(): boolean {
  const connection = getLanCacheConnection()
  return Boolean(connection && !connection.pending)
}

/** For resolve-cache keys — same rationale as jellyfinFingerprint: the URL
 *  is enough to invalidate on re-pointing, and the token never lands in a
 *  persisted key. */
export function lanCacheFingerprint(): string {
  return getLanCacheConnection()?.url ?? 'off'
}

/** The lookup's answer, or null once LAN_LOOKUP_TIMEOUT_MS have passed since
 *  the call, whether the request is still queued in the lane or on the wire.
 *  A request that loses the race is left to settle unread; its rejection is
 *  caught here so it is not reported as unhandled. */
function withinLookupTime<T>(pending: Promise<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), LAN_LOOKUP_TIMEOUT_MS)
    pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Tier 2 lookup: does the paired daemon hold this title, complete?
 *
 * One LAN round-trip; in-flight and tombstoned items deliberately do NOT
 * produce a candidate — a half-fetched file cannot be played (the daemon
 * 404s incomplete items on /stream), and playback has other tiers.
 */
export async function findLanCacheCandidate(contentKey: string): Promise<StreamCandidate | null> {
  if (!contentKey || !isLanCacheConnected()) return null
  try {
    const catalog = await withinLookupTime(
      request<LanCacheCatalogResponse>(
        `/api/catalog?keys=${encodeURIComponent(contentKey)}`,
        {},
        LAN_LOOKUP_TIMEOUT_MS
      )
    )
    if (!catalog) return null
    const item = catalog.items.find((entry) => entry.contentKey === contentKey && entry.complete)
    if (!item) return null
    return {
      source: 'lancache',
      infoHash: item.infoHash,
      name: item.title,
      // The release line — what streamReleaseName reads for the Info
      // panel and the release-group memo — is the stored file's name when
      // the daemon reports it; the catalog title names no release.
      title: item.fileName || item.title,
      resolution: item.resolution,
      sizeBytes: item.sizeBytes,
      cached: true,
      compatible: true,
      exact: true
    }
  } catch {
    // Unreachable daemon = tier contributes nothing.
    return null
  }
}

/** The URL the player opens. Token in the query — mpv cannot send headers;
 *  identical pattern (and identical logging caution) to Jellyfin's api_key. */
export function lanCacheStreamUrl(candidate: StreamCandidate): string | null {
  const connection = getLanCacheConnection()
  if (!connection || candidate.source !== 'lancache' || !candidate.infoHash) return null
  return `${connection.url}/stream/${candidate.infoHash}?token=${encodeURIComponent(connection.token)}`
}

export async function queueLanCacheJob(payload: LanCacheJobPayload): Promise<boolean> {
  try {
    await request('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return true
  } catch (error) {
    logError('lancache:queue', error)
    return false
  }
}

/**
 * One page of the daemon's household title index, by watermark. Null on
 * ANY failure — unreachable, unpaired, or a pre-title-tier daemon
 * answering 404 — because to the sync pass those are all the same fact:
 * no rows this time, try again next pass.
 */
export async function lanCacheTitles(
  kind: string,
  since: number,
  limit: number
): Promise<LanCacheTitlesResponse | null> {
  if (!isLanCacheConnected()) return null
  try {
    return await request<LanCacheTitlesResponse>(
      `/api/titles?kind=${encodeURIComponent(kind)}&since=${Math.max(0, Math.floor(since))}&limit=${limit}`
    )
  } catch {
    return null
  }
}

/** Ask the daemon to re-crawl upstream. The three wire states pass through
 *  verbatim; 'unavailable' is this client's own word for a daemon that is
 *  unpaired, unreachable, or too old to have a title index. */
export async function lanCacheTitlesRefresh(
  kind?: string
): Promise<LanCacheTitlesRefreshResponse | { state: 'unavailable' }> {
  if (!isLanCacheConnected()) return { state: 'unavailable' }
  try {
    return await request<LanCacheTitlesRefreshResponse>('/api/titles/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kind ? { kind } : {})
    })
  } catch {
    return { state: 'unavailable' }
  }
}

export async function lanCacheCatalog(keys: string[]): Promise<LanCacheCatalogResponse | null> {
  if (!isLanCacheConnected()) return null
  try {
    const query = keys.length ? `?keys=${encodeURIComponent(keys.join(','))}` : ''
    return await request<LanCacheCatalogResponse>(`/api/catalog${query}`)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Waiting to be let in.
//
// Approval happens on somebody else's machine, at a time nobody here
// controls, and the thing it unblocks is the whole cache TIER — not a piece
// of UI. So the wait is owned by the main process rather than by whichever
// panel happens to be on screen.
//
// It used to be owned by the control centre's Caching section, which meant
// approval was only ever noticed while that section was open: a person who
// asked to join from Settings and closed the panel stayed pending forever,
// with a cache server that had already said yes.

/** How often the main process asks. Slower than the panel's own poll, which
 *  exists to make the transition feel immediate while somebody is watching
 *  it; this one is the part that has to work when nobody is. */
const APPROVAL_POLL_MS = 30_000

let approvalTimer: NodeJS.Timeout | null = null

/**
 * Asks whether a pending device has been approved, and promotes it if so.
 *
 * The single place that transition happens — the timer below and the
 * renderer's own poll both come through here, so the two cannot promote a
 * connection differently.
 */
export async function promoteIfApproved(): Promise<'none' | 'pending' | 'approved'> {
  const connection = getLanCacheConnection()
  if (!connection) return 'none'
  if (!connection.pending) return 'approved'
  // Deliberately NOT through request(): this is the one call a pending token
  // is allowed to make, and routing it past the guard that refuses
  // everything else keeps that exception visible.
  const answer = await fetchJson<{ status?: string; serverName?: string }>(
    `${connection.url}/api/pair/status`,
    { headers: { Authorization: `Bearer ${connection.token}` } },
    { lane: 'lancache', label: 'cache server' }
  )
  if (answer.status !== 'approved') return 'pending'

  setLanCacheConnection({
    url: connection.url,
    name: answer.serverName ?? connection.name,
    token: connection.token
  })
  // Approval is what actually grants the player access to this LAN host, so
  // the trusted-host list is refreshed HERE — the moment that now carries
  // the authority pairing used to.
  refreshTrustedHostsRef?.()
  // Said out loud: the request may have been made by the launch-time search
  // hours ago, with no panel open to see the answer arrive.
  emit({ kind: 'approved', serverName: answer.serverName ?? connection.name })

  // And the opt-in the person made when they asked, which could not be
  // honoured then because a pending token authorises nothing. Sent once;
  // the flag is already gone from the connection written above, so a later
  // call cannot re-send it.
  if (connection.shareTorbox) {
    const torboxToken = getTorBoxToken()
    if (torboxToken) {
      await request('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torboxToken })
      }).catch((error) => logError('lancache:credentials', error))
    }
  }
  return 'approved'
}

/** Runs the wait while, and only while, there is something to wait for. */
function syncApprovalPolling(): void {
  const connection = getLanCacheConnection()
  const wanted = Boolean(connection?.pending)
  if (wanted && !approvalTimer) {
    approvalTimer = setInterval(() => {
      void promoteIfApproved()
        .then((state) => {
          if (state !== 'pending') syncApprovalPolling()
        })
        // A daemon that is off or unreachable is the ordinary case while
        // waiting — somebody has to walk to it. Keep asking.
        .catch(() => {})
    }, APPROVAL_POLL_MS)
    // Never a reason to hold the process open.
    approvalTimer.unref?.()
  } else if (!wanted && approvalTimer) {
    clearInterval(approvalTimer)
    approvalTimer = null
  }
}

/** Set once at registration. Module-level because promoteIfApproved runs
 *  from a timer, outside any IPC call that could carry it. */
let refreshTrustedHostsRef: (() => void) | null = null

function emit(event: LanCacheAppEvent): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.lanCacheEvent, event)
}

// ---------------------------------------------------------------------------
// Asking to join — the one path every join takes, whether a person pressed
// Ask to join or the launch-time search found a server on its own.

export interface JoinResult {
  ok: boolean
  message: string
  pending?: boolean
  serverName?: string
}

/**
 * Takes back a request that is still waiting, best-effort. A daemon from
 * before POST /api/pair/withdraw answers 404, and one that has already let
 * the device in answers 409; either way the entry stays for the
 * administrator to remove, which is how it always was.
 */
async function withdrawRequest(url: string, token: string): Promise<boolean> {
  try {
    await fetchJson(
      `${url}/api/pair/withdraw`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      { lane: 'lancache', label: 'cache server', timeoutMs: ADDRESS_CHECK_TIMEOUT_MS }
    )
    return true
  } catch {
    return false
  }
}

/** Cancel while waiting: takes the stored request out of the
 *  administrator's queue rather than leaving it for them to deny. Does not
 *  forget the connection; the caller does that. */
export async function cancelLanCacheRequest(): Promise<boolean> {
  const waiting = getLanCacheConnection()
  if (!waiting?.pending) return false
  return withdrawRequest(waiting.url, waiting.token)
}

export async function askToJoin(
  rawUrl: string,
  options: {
    /** The explicit opt-in: copy the TorBox token to the daemon so it can
     *  fetch overnight with no app running. Never implied, so the launch
     *  search never sets it. */
    shareTorboxToken?: boolean
    /** For the launch search: whether the join is still wanted. Asked
     *  before each request and again once the server has answered, since a
     *  person may join by hand, or press Leave, while the search runs. */
    stillWanted?: () => boolean
  } = {}
): Promise<JoinResult> {
  const url = String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) return { ok: false, message: 'Enter the server URL.' }
  const unwanted: JoinResult = { ok: false, message: 'No longer looking for a cache server.' }
  const wanted = (): boolean => options.stillWanted?.() ?? true
  // Checked before anything is sent: every POST /api/pair creates a device
  // on the server, so a request that is going to be thrown away must not be
  // made at all.
  if (!wanted()) return unwanted
  try {
    // Identity check first: refuse to ask to join something
    // that is not an r3-cache daemon at all.
    const ping = await fetchJson<LanCachePingResponse>(
      `${url}/api/ping`,
      {},
      { lane: 'lancache', label: 'cache server' }
    )
    if (ping.product !== 'r3-cache') {
      return { ok: false, message: 'That server is not an r3-cache daemon.' }
    }
    if (!wanted()) return unwanted
    const paired = await fetchJson<LanCachePairResponse>(
      `${url}/api/pair`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The device NAME is sent either way: it is what the server's
        // administrator sees in the approval list, so an unnamed
        // request is one nobody can sensibly say yes to.
        body: JSON.stringify({ deviceName: os.hostname() })
      },
      { lane: 'lancache', label: 'cache server' }
    )
    if (!paired.token) {
      // The daemon refuses a request when too many devices are already
      // waiting, or when they are arriving too fast. Both are temporary
      // and neither is about this device, so the wording says to try
      // again rather than suggesting something is wrong here.
      return {
        ok: false,
        message: 'The cache server is not taking requests right now. Try again shortly.'
      }
    }
    if (!wanted()) {
      // A join made by hand, or a Leave, won while this POST was in flight.
      // Take the request back so it does not sit in the administrator's
      // queue. (A server in open join has already let it in, and that entry
      // stays for the administrator to remove.)
      await withdrawRequest(url, paired.token)
      return unwanted
    }
    const serverName = paired.serverName ?? ping.serverName
    const pending = paired.status === 'pending'
    setLanCacheConnection({
      url,
      name: serverName,
      token: paired.token,
      ...(pending ? { pending: true } : {}),
      // The opt-in is KEPT rather than acted on while pending: a pending
      // token authorises nothing, so posting the credential now would
      // simply be refused. promoteIfApproved sends it the moment
      // approval lands.
      ...(pending && options.shareTorboxToken ? { shareTorbox: true } : {})
    })
    if (pending) {
      // Nothing is granted yet — not the trusted-host entry, and not the
      // TorBox copy below. Both wait for approval, which is the point of
      // asking. The wait itself belongs to the main process, so it runs
      // whether or not any panel is open to watch it.
      syncApprovalPolling()
      return {
        ok: true,
        pending: true,
        serverName,
        message: `Waiting for ${serverName ?? 'the cache server'}'s administrator to approve this device.`
      }
    }
    // Pairing is what grants the player access to this LAN host.
    refreshTrustedHostsRef?.()

    if (options.shareTorboxToken) {
      const torboxToken = getTorBoxToken()
      if (torboxToken) {
        await request('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ torboxToken })
        }).catch((error) => logError('lancache:credentials', error))
      }
    }
    return { ok: true, serverName, message: `Paired with ${serverName ?? 'the cache server'}.` }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Finding the server without anyone typing an address.
//
// The address used to be typed by hand and then trusted forever, so a
// server whose DHCP lease moved it (r3-host went .237 -> .234 -> .243 in a
// month) silently took the whole cache tier with it. Two jobs fix that, both
// run at launch and then on a slow timer:
//
//   - no server yet: search the network and ask to join the first one that
//     answers. Open join lets this device straight in; otherwise the request
//     waits for the administrator, whose own app is told (see
//     checkJoinRequests below). Leave turns this off until the person asks
//     to join by hand again, or Leave would undo itself on the next start.
//   - a server already: if it no longer answers where it was, search for it
//     elsewhere and move the stored address.
//
// A typed address is still the override. It is never replaced while it
// answers, only when it has stopped answering and the same server has been
// found somewhere else.

/** How long the stored address gets before it counts as gone. Same budget as
 *  the play-time lookup: a server on this network answers in milliseconds. */
const ADDRESS_CHECK_TIMEOUT_MS = LAN_LOOKUP_TIMEOUT_MS
/** The slow timer. The address only moves when a lease does, and a fresh
 *  install is found at launch, so there is nothing to gain from asking often. */
const AUTO_CONNECT_INTERVAL_MS = 30 * 60 * 1000
/** Left after launch before the first search, so it never competes with the
 *  app becoming usable. */
const AUTO_CONNECT_DELAY_MS = 5_000

type TokenCheck = 'known' | 'unknown' | 'unreachable'

/** Whether a server at this address knows this device's token. 401 means a
 *  server answered and does not; anything else failing means nobody did.
 *
 *  'known' needs a real pairing-status answer, not just a 200: the old
 *  address may now belong to some other web service with a catch-all page
 *  (httpClient tolerates a body that is not JSON), and taking that for the
 *  daemon would hold the connection on a dead address forever. */
async function checkToken(url: string, token: string): Promise<TokenCheck> {
  try {
    const answer = await fetchJson<{ status?: unknown } | null>(
      `${url}/api/pair/status`,
      { headers: { Authorization: `Bearer ${token}` } },
      { lane: 'lancache', label: 'cache server', timeoutMs: ADDRESS_CHECK_TIMEOUT_MS }
    )
    const status = answer && typeof answer === 'object' ? answer.status : undefined
    return status === 'approved' || status === 'pending' ? 'known' : 'unreachable'
  } catch (error) {
    return (error as HttpError).status === 401 ? 'unknown' : 'unreachable'
  }
}

/** Compared the way the daemon's mDNS announcer spells its instance label
 *  (daemon/mdns.ts's safeLabel), since an mDNS hit carries that label and a
 *  ping carries the raw name: "r3-host.lan" announces as "r3-host-lan". */
function sameName(a: string, b: string): boolean {
  const label = (name: string): string =>
    name
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  return label(a) === label(b)
}

export type AddressCheck = 'none' | 'current' | 'moved' | 'lost'

/**
 * Keeps the stored address pointing at the server this device joined.
 *
 * A candidate is accepted only when it carries the stored server's NAME and
 * then recognises this device's token, so the move lands on the same server
 * rather than on whatever answered first. The name test comes first so the
 * token is offered only to a server that already claims to be this one, not
 * to every daemon on the network. That is hygiene, not a proof: a host on
 * the LAN could copy the name, and the token already crosses the LAN in the
 * clear on every request, so this adds nothing a LAN attacker lacks today.
 */
export async function keepLanCacheAddressCurrent(
  discover: () => Promise<DiscoveredLanCache[]>
): Promise<AddressCheck> {
  const connection = getLanCacheConnection()
  if (!connection) return 'none'
  if ((await checkToken(connection.url, connection.token)) === 'known') return 'current'

  const found = await discover()
  for (const server of found) {
    if (server.url === connection.url) continue
    if (connection.name && !sameName(server.name, connection.name)) continue
    if ((await checkToken(server.url, connection.token)) !== 'known') continue
    // Re-read: the person may have left, or joined another server, while
    // the search ran. Only the connection that was searched for is moved.
    const latest = getLanCacheConnection()
    if (!latest || latest.token !== connection.token) return 'none'
    setLanCacheConnection({ ...latest, url: server.url })
    refreshTrustedHostsRef?.()
    emit({ kind: 'moved', serverName: latest.name || server.name, url: server.url })
    return 'moved'
  }
  return 'lost'
}

/**
 * One launch-time (or timer) pass: move a server that has moved, or find
 * and ask to join one when there is none and Leave has not switched that off.
 */
export async function runLanCacheAutoConnect(
  discover: () => Promise<DiscoveredLanCache[]> = () => findLanCaches()
): Promise<AddressCheck | 'asked' | 'joined' | 'off' | 'nothing-found'> {
  if (getLanCacheConnection()) return keepLanCacheAddressCurrent(discover)
  if (!isLanCacheAutoJoinOn()) return 'off'
  const found = await discover()
  for (const server of found) {
    const result = await askToJoin(server.url, {
      // Re-asked after the search: Leave may have been pressed meanwhile.
      stillWanted: () => !getLanCacheConnection() && isLanCacheAutoJoinOn()
    })
    if (!result.ok) continue
    const serverName = result.serverName || server.name
    emit({ kind: result.pending ? 'asked' : 'joined', serverName })
    return result.pending ? 'asked' : 'joined'
  }
  return 'nothing-found'
}

let autoConnectRunning = false

/** Guarded so the timer and a slow launch pass never overlap. */
function autoConnectPass(discover?: () => Promise<DiscoveredLanCache[]>): void {
  if (autoConnectRunning) return
  autoConnectRunning = true
  void runLanCacheAutoConnect(discover)
    .catch((error) => logError('lancache:auto-connect', error))
    .finally(() => {
      autoConnectRunning = false
    })
}

// ---------------------------------------------------------------------------
// The administrator's side: somebody is asking to join.
//
// The daemon already queues the request and the Caching section already
// lists it with Approve and Deny. What was missing is being TOLD: the
// administrator only found out by opening that section. So the
// administrator's app polls the device list and raises each new request
// once, as a toast with Allow and Deny (and a desktop notification when the
// window is not in front, since the request can arrive at any time).

/** How often the administrator's app looks. Requests are rare and a person
 *  is standing at the other device waiting, so this leans towards prompt. */
const JOIN_REQUEST_POLL_MS = 20_000
/** A device that is not the administrator gets 403 here. Asking again every
 *  twenty seconds would be a request nobody needs, so a refusal is believed
 *  for this long (the role changes by claim, which is rare). */
const NOT_ADMIN_BACKOFF_MS = 10 * 60 * 1000

/** Raised once each per run. A request still waiting at the next launch is
 *  raised again, which is the reminder somebody would want. */
const raisedJoinRequests = new Set<string>()
/** The 403 back-off, kept with the token it was learned from: a refusal says
 *  nothing about a different connection, or about this one after it claims. */
let notAdmin: { token: string; until: number } | null = null

/**
 * New join requests this device should raise, if it administers the server.
 * Each one is returned once; an empty list for anything else (not the
 * administrator, not connected, server away).
 */
export async function checkJoinRequests(now = Date.now()): Promise<LanCacheDevice[]> {
  const connection = getLanCacheConnection()
  if (!connection || connection.pending) return []
  if (notAdmin && notAdmin.token === connection.token && now < notAdmin.until) return []
  let answer: LanCacheDevicesResponse
  try {
    answer = await request<LanCacheDevicesResponse>(
      '/api/admin/devices',
      {},
      ADDRESS_CHECK_TIMEOUT_MS
    )
  } catch (error) {
    if ((error as HttpError).status === 403) {
      notAdmin = { token: connection.token, until: now + NOT_ADMIN_BACKOFF_MS }
    }
    return []
  }
  notAdmin = null
  const fresh = answer.devices.filter(
    (device) => device.status === 'pending' && !raisedJoinRequests.has(device.id)
  )
  for (const device of fresh) raisedJoinRequests.add(device.id)
  return fresh
}

/** A desktop notification, only when the app is not what somebody is looking
 *  at — in front, the toast already says it. Clicking brings the app forward,
 *  where the toast's Allow and Deny are. */
function notifyDesktop(title: string, body: string): void {
  try {
    const { BrowserWindow, Notification } = electronModule()
    if (!Notification.isSupported()) return
    if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) return
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    notification.show()
  } catch {
    // Not inside Electron (the headless backend): the toast is all there is.
  }
}

async function raiseJoinRequests(): Promise<void> {
  const fresh = await checkJoinRequests()
  const serverName = getLanCacheConnection()?.name || 'the cache server'
  for (const device of fresh) {
    emit({ kind: 'join-request', id: device.id, deviceName: device.deviceName, serverName })
    notifyDesktop(
      'A device wants to use your cache server',
      `${device.deviceName} on your network is asking to use ${serverName}. Open R3 Media Hub to allow or deny it.`
    )
  }
}

/** Test seam: forget what has been raised and any 403 back-off. */
export function resetJoinRequestState(): void {
  raisedJoinRequests.clear()
  notAdmin = null
}

// ---------------------------------------------------------------------------
// IPC: discovery, pairing, status — the Settings pane's surface.

interface DeviceActionPayload {
  id: string
  action: 'approve' | 'deny' | 'revoke' | 'quota'
  /** For 'quota' only. null clears it back to the server default. */
  quotaBytes?: number | null
}

interface PairPayload {
  url: string

  /** The explicit opt-in: copy the TorBox token to the daemon so it can
   *  fetch overnight with no app running. Never implied. */
  shareTorboxToken?: boolean
}

export function registerLanCacheIpc(refreshTrustedHosts: () => void): void {
  refreshTrustedHostsRef = refreshTrustedHosts
  // A device can be left waiting across a restart, so the wait resumes at
  // startup rather than only after somebody opens the panel again.
  syncApprovalPolling()

  // Find (or follow) the cache server without anyone typing an address. The
  // launch pass may probe the subnet; the timer's passes use mDNS alone, so a
  // laptop away from home is not asking a café's network every half hour.
  setTimeout(() => autoConnectPass(), AUTO_CONNECT_DELAY_MS).unref?.()
  setInterval(
    () => autoConnectPass(() => findLanCaches({ probe: 'never' })),
    AUTO_CONNECT_INTERVAL_MS
  ).unref?.()
  setInterval(() => {
    void raiseJoinRequests().catch((error) => logError('lancache:join-requests', error))
  }, JOIN_REQUEST_POLL_MS).unref?.()

  handle(MEDIA_HUB_CHANNELS.lanCacheDiscover, async () => {
    const found = await findLanCaches()
    return { daemons: found, paired: getLanCacheConnection()?.url ?? null }
  })

  handle<PairPayload, JoinResult>(MEDIA_HUB_CHANNELS.lanCachePair, async (_event, payload) => {
    const result = await askToJoin(String(payload?.url || ''), {
      shareTorboxToken: payload?.shareTorboxToken === true
    })
    // Asking by hand is the person saying they want a cache server again,
    // so a Leave that switched the launch search off is undone here.
    if (result.ok) setLanCacheAutoJoin(true)
    return result
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheUnpair, async () => {
    // Best-effort credential revocation on the daemon before forgetting it.
    if (isLanCacheConnected()) {
      await request('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torboxToken: '' })
      }).catch(() => {})
    } else {
      await cancelLanCacheRequest()
    }
    clearLanCacheConnection()
    // Or the launch search would find the same server and ask again.
    setLanCacheAutoJoin(false)
    refreshTrustedHosts()
    // Nothing left to wait for.
    syncApprovalPolling()
    return { ok: true }
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheStatus, async () => {
    if (!isLanCacheConnected()) return { connected: false as const }
    try {
      const status = await request<LanCacheStatusResponse>('/api/status')
      return { connected: true as const, status }
    } catch (error) {
      return { connected: true as const, error: (error as Error).message }
    }
  })

  // --- pending pairing, and the server's own administration ---------------
  //
  // Pairing no longer necessarily ends in access. A codeless request gets a
  // real token that authorises nothing until the server's administrator
  // approves it, so the app stores the connection as PENDING and polls.
  // Everything below is the surface a control centre needs to run that.

  handle(MEDIA_HUB_CHANNELS.lanCachePairStatus, async () => {
    const connection = getLanCacheConnection()
    if (!connection) return { state: 'none' as const }
    try {
      // Through the same promotion path the timer uses, so a panel watching
      // this cannot end up with a connection promoted differently from one
      // the background wait promoted.
      const state = await promoteIfApproved()
      syncApprovalPolling()
      return { state, name: getLanCacheConnection()?.name ?? connection.name }
    } catch (error) {
      return { state: 'pending' as const, name: connection.name, error: (error as Error).message }
    }
  })

  handle<void, { ok: boolean; message: string }>(MEDIA_HUB_CHANNELS.lanCacheClaim, async () => {
    if (!isLanCacheConnected()) return { ok: false, message: 'No cache server is paired.' }
    try {
      await request('/api/admin/claim', { method: 'POST' })
      // Administrator now: start looking for join requests at once.
      notAdmin = null
      return { ok: true, message: 'You administer this cache server.' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheDevices, async () => {
    if (!isLanCacheConnected()) return { ok: false as const, message: 'No cache server is paired.' }
    try {
      return {
        ok: true as const,
        ...(await request<LanCacheDevicesResponse>('/api/admin/devices'))
      }
    } catch (error) {
      return { ok: false as const, message: (error as Error).message }
    }
  })

  handle<DeviceActionPayload, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheDeviceAction,
    async (_event, payload) => {
      // Validated here rather than passed through: the renderer is the least
      // trusted caller in this process, and the daemon's route is addressed
      // by an id that goes straight into a URL.
      const id = String(payload?.id ?? '')
      if (!/^[a-f0-9]{16}$/.test(id)) return { ok: false, message: 'Unknown device.' }
      const action = payload?.action
      if (action !== 'approve' && action !== 'deny' && action !== 'revoke' && action !== 'quota') {
        return { ok: false, message: 'Unknown action.' }
      }
      try {
        await request(`/api/admin/devices/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(action === 'quota' ? { quotaBytes: payload?.quotaBytes ?? null } : {})
          })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<{ openJoin?: boolean; defaultQuotaPercent?: number }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheAdminSettings,
    async (_event, payload) => {
      try {
        await request('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(typeof payload?.openJoin === 'boolean' ? { openJoin: payload.openJoin } : {}),
            ...(typeof payload?.defaultQuotaPercent === 'number'
              ? { defaultQuotaPercent: payload.defaultQuotaPercent }
              : {})
          })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  // The library hero's household controls: a cheap paired? probe (no
  // network — it reads the stored connection) and the refresh relay.
  handle(MEDIA_HUB_CHANNELS.lanCacheTitlesState, async () => ({
    paired: isLanCacheConnected()
  }))

  handle<{ kind?: unknown }, LanCacheTitlesRefreshResponse | { state: 'unavailable' }>(
    MEDIA_HUB_CHANNELS.lanCacheTitlesRefresh,
    async (_e, payload) => {
      const kind = payload?.kind
      if (kind !== undefined && kind !== 'movie' && kind !== 'series' && kind !== 'anime') {
        return { state: 'unavailable' }
      }
      return lanCacheTitlesRefresh(kind)
    }
  )

  handle(MEDIA_HUB_CHANNELS.lanCacheUpdateNow, async () => {
    if (!isLanCacheConnected()) {
      return { ok: false as const, message: 'Not connected to a cache server.' }
    }
    try {
      // A long timeout on purpose: this checks the release feed and may
      // download a bundle before it answers, which on a slow link is not a
      // few hundred milliseconds. The default would give up and report a
      // failure for an update that was in fact working.
      const answer = await request<LanCacheUpdateNowResponse>(
        '/api/admin/update',
        { method: 'POST' },
        UPDATE_NOW_TIMEOUT_MS
      )
      return { ok: true as const, ...answer }
    } catch (error) {
      return { ok: false as const, message: (error as Error).message }
    }
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheMyItems, async () => {
    if (!isLanCacheConnected()) return { ok: false as const, items: [] }
    try {
      const answer = await request<{ items: LanCacheOwnItem[] }>('/api/items/mine')
      return { ok: true as const, items: answer.items ?? [] }
    } catch {
      // An older daemon has no such route. Empty rather than an error: the
      // section already tells people their server predates this work, and a
      // second failure message about it would be noise.
      return { ok: false as const, items: [] }
    }
  })

  handle<{ infoHash?: string; visibility?: string }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheSetSharing,
    async (_event, payload) => {
      // Validated here, not passed through: the hash goes straight into a
      // URL and the renderer is the least trusted caller in this process.
      const infoHash = String(payload?.infoHash ?? '')
      if (!/^[a-f0-9]{40}$/.test(infoHash)) return { ok: false, message: 'Unknown item.' }
      const visibility = payload?.visibility === 'shared' ? 'shared' : 'private'
      try {
        await request(`/api/items/${infoHash}/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<{ infoHash?: string }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheRemoveItem,
    async (_event, payload) => {
      const infoHash = String(payload?.infoHash ?? '')
      if (!/^[a-f0-9]{40}$/.test(infoHash)) return { ok: false, message: 'Unknown item.' }
      try {
        await request(`/api/items/${infoHash}/remove`, { method: 'POST' })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<{ contentKey?: string }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheCancelJob,
    async (_event, payload) => {
      // The contentKey goes in the BODY, not the path: it contains colons
      // and a catalogId can contain more of them, so a path segment would
      // need escaping on both sides to survive the round trip.
      const contentKey = String(payload?.contentKey ?? '')
      if (!contentKey) return { ok: false, message: 'Unknown job.' }
      try {
        await request('/api/jobs/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentKey })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )
}
