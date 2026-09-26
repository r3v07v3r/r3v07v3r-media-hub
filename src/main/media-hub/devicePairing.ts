// Linking a phone to this desktop: the desktop's one-shot listener, the
// phone's fetch, and the IPC for both. The format, the crypto and what is
// in the bundle live in devicePairingCore.ts — read that first.
//
// Both halves run in every build. The desktop is the one that usually
// starts a ticket and the phone (the headless backend on Android) the one
// that redeems it, but nothing depends on which is which, so two desktops
// can pair the same way.

import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  PAIRING_MAX_MISSES,
  PAIRING_PATH_PREFIX,
  PAIRING_TTL_MS,
  applyBundle,
  buildBundle,
  bundleContents,
  newTicket,
  openBundle,
  parsePairingHost,
  parseTicketLink,
  sealBundle,
  ticketLink,
  type PairingTicket
} from './devicePairingCore'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { decrypt, encrypt, readSettings, writeSettings } from './settingsStore'

export type PairingState = 'idle' | 'waiting' | 'done' | 'expired' | 'failed' | 'cancelled'

export interface PairingStartResult {
  ok: boolean
  message?: string
  link?: string
  expiresAt?: number
  /** What was sealed into the ticket, so the screen can say what the phone
   *  is about to receive before anybody scans anything. */
  contents?: string[]
}

export interface PairingRedeemResult {
  ok: boolean
  message: string
  imported?: string[]
}

interface ActiveTicket {
  server: http.Server
  timer: NodeJS.Timeout
  state: PairingState
  misses: number
}

let active: ActiveTicket | null = null
let lastState: PairingState = 'idle'

/** Private IPv4 addresses this machine can be reached on, best guesses
 *  first: home Wi-Fi ranges ahead of VPN-style ones. */
function lanAddresses(): string[] {
  const rank = (a: string): number =>
    a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('172.') ? 2 : 3
  const found = new Set<string>()
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('127.')) continue
      if (parsePairingHost(`${entry.address}:1`)) found.add(entry.address)
    }
  }
  return [...found].sort((a, b) => rank(a) - rank(b))
}

function finish(state: PairingState): void {
  if (!active) return
  const ending = active
  active = null
  lastState = state
  clearTimeout(ending.timer)
  ending.server.close()
  // A phone that fetched is done with the connection; nobody else should
  // be holding one open, and closeAllConnections makes sure of it.
  ending.server.closeAllConnections?.()
}

function idMatches(ticket: PairingTicket, candidate: string): boolean {
  const presented = Buffer.from(candidate, 'base64url')
  return presented.length === ticket.id.length && crypto.timingSafeEqual(presented, ticket.id)
}

/**
 * Seals one snapshot and starts listening for the phone. Starting again
 * replaces whatever ticket was open: only the code on screen now works.
 */
export async function startPairing(): Promise<PairingStartResult> {
  finish('cancelled')
  const addresses = lanAddresses()
  if (addresses.length === 0) {
    return {
      ok: false,
      message: 'This computer is not on a local network the phone could reach.'
    }
  }

  const settings = readSettings()
  const bundle = buildBundle(settings, decrypt, os.hostname())
  const contents = bundleContents(bundle)
  if (contents.length === 0) {
    return { ok: false, message: 'There is nothing on this computer to send yet.' }
  }

  // The ticket needs the port, and the port needs a listening server, so
  // the server starts first and learns its ticket just after.
  let ticket: PairingTicket | null = null
  let sealed: string | null = null
  const server = http.createServer((req, res) => {
    const current = active
    const reply = (status: number, body = ''): void => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Connection: 'close'
      })
      res.end(body)
    }
    if (!current || current.server !== server || !ticket || !sealed) return reply(410)
    const path = String(req.url || '')
    if (req.method !== 'GET' || !path.startsWith(PAIRING_PATH_PREFIX)) return reply(404)
    if (!idMatches(ticket, path.slice(PAIRING_PATH_PREFIX.length))) {
      current.misses += 1
      reply(404)
      if (current.misses >= PAIRING_MAX_MISSES) finish('failed')
      return
    }
    const body = sealed
    // Forget the ciphertext before answering: one ticket, one answer.
    sealed = null
    reply(200, body)
    finish('done')
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => resolve())
    })
  } catch (error) {
    logError('devicePairing.listen', error)
    return { ok: false, message: 'Could not open a port for the phone to connect to.' }
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  ticket = newTicket(addresses.map((a) => `${a}:${port}`))
  sealed = JSON.stringify(sealBundle(ticket, bundle))
  const expiresAt = Date.now() + PAIRING_TTL_MS
  active = {
    server,
    state: 'waiting',
    misses: 0,
    timer: setTimeout(() => finish('expired'), PAIRING_TTL_MS)
  }
  lastState = 'waiting'
  return { ok: true, link: ticketLink(ticket), expiresAt, contents }
}

export function pairingState(): PairingState {
  return active ? 'waiting' : lastState
}

export function cancelPairing(): void {
  finish('cancelled')
}

/** The phone's half: fetch the sealed snapshot, open it, keep it. */
export async function redeemPairing(link: string): Promise<PairingRedeemResult> {
  const parsed = parseTicketLink(link)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const { ticket } = parsed

  let sawRefusal = false
  for (const host of ticket.hosts) {
    let response: Response
    try {
      response = await fetch(
        `http://${host}${PAIRING_PATH_PREFIX}${ticket.id.toString('base64url')}`,
        {
          signal: AbortSignal.timeout(5000),
          redirect: 'error'
        }
      )
    } catch (error) {
      // Refused means the computer is there and the port is shut: the
      // listener closes as soon as its code is used or runs out. A timeout
      // is the one that means "not reachable at all".
      const code = (error as { cause?: { code?: string } }).cause?.code
      if (code === 'ECONNREFUSED') sawRefusal = true
      continue
    }
    if (!response.ok) {
      sawRefusal = true
      continue
    }
    const bundle = openBundle(ticket, await response.json().catch(() => null))
    if (!bundle) {
      return { ok: false, message: 'The computer answered, but not with this code. Scan it again.' }
    }
    writeSettings(applyBundle(readSettings(), bundle, encrypt))
    return {
      ok: true,
      message: `Linked to ${bundle.from}.`,
      imported: bundleContents(bundle)
    }
  }
  return {
    ok: false,
    message: sawRefusal
      ? 'That code has already been used or has expired. Show a new one on the computer.'
      : 'Could not reach the computer. Check that both are on the same Wi-Fi, and that the computer’s firewall lets R3 Media Hub accept connections.'
  }
}

export function registerDevicePairingIpc(): void {
  handle<undefined, PairingStartResult>(MEDIA_HUB_CHANNELS.devicePairingStart, () => startPairing())
  handle<undefined, { state: PairingState }>(MEDIA_HUB_CHANNELS.devicePairingStatus, () => ({
    state: pairingState()
  }))
  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.devicePairingCancel, () => {
    cancelPairing()
    return { ok: true }
  })
  handle<{ link: string }, PairingRedeemResult>(
    MEDIA_HUB_CHANNELS.devicePairingRedeem,
    (_event, payload) => redeemPairing(String(payload?.link || ''))
  )
}
