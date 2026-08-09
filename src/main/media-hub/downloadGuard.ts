// The last line of defence: nothing on the blocklist reaches disk.
//
// Before this there was no `will-download` handler anywhere in the app, on
// any session. Electron's default behaviour for a download it is handed is
// to save it — so any redirect, any embedded page (trailers load YouTube),
// any future feature that fetches a file, could write an executable to the
// downloads folder with nothing in the way. Nothing in the app deliberately
// downloads files today, which is exactly why this is worth wiring: the
// guard should already be in place before the feature that needs it is
// written, not after.
//
// Installed on EVERY session rather than just the main window's. Sessions
// are created for partitions, for webviews, and by Electron itself; a guard
// that only covers `defaultSession` is one `partition:` attribute away from
// being bypassed, and that's not a thing to leave depending on how someone
// later configures a BrowserWindow.

import { app, session, type DownloadItem, type Session } from 'electron'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { BlockedDownload } from '../../shared/media-hub/types'
import {
  blockedReason,
  isBlockedFilename,
  isBlockedMimeType
} from '../../shared/media-hub/unsafeFiles'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'

/** Everything blocked this run, newest last. Kept in memory only: it's for
 *  telling the person what just happened, not an audit trail. */
const blocked: BlockedDownload[] = []
const MAX_REMEMBERED = 50

export function blockedDownloads(): BlockedDownload[] {
  return [...blocked]
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

function onWillDownload(event: Electron.Event, item: DownloadItem): void {
  const filename = item.getFilename()
  const mimeType = item.getMimeType()
  if (!isBlockedFilename(filename) && !isBlockedMimeType(mimeType)) return

  const reason = blockedReason(filename, mimeType) ?? 'This file type is blocked.'
  const host = hostOf(item.getURL())

  // cancel() alone is not enough: Electron has already decided on a save
  // path by the time this fires, and on some platforms a partial file can
  // be created before the cancel lands. preventDefault() stops the
  // download from ever being handed to the file system in the first
  // place; cancel() then tears down the item itself.
  event.preventDefault()
  try {
    item.cancel()
  } catch {
    // Already gone — preventDefault did the work.
  }

  const record: BlockedDownload = { filename, reason, host }
  blocked.push(record)
  if (blocked.length > MAX_REMEMBERED) blocked.shift()

  // Deliberately loud. A download this app refused is either a genuine
  // attack or a bug in this app, and both are worth knowing about;
  // silently dropping it would leave someone hunting for a file that
  // never arrived.
  logError('download:blocked', `refused "${filename}" (${mimeType || 'no mime'}) from ${host}`)
  sendToRenderer(MEDIA_HUB_CHANNELS.downloadBlocked, record)
}

/**
 * Wires the guard onto one session. Safe to call repeatedly — the listener
 * is removed first, so a session that somehow arrives twice can't end up
 * cancelling the same item twice.
 */
function guardSession(target: Session): void {
  target.removeListener('will-download', onWillDownload)
  target.on('will-download', onWillDownload)
}

export function registerDownloadGuardIpc(): void {
  handle<undefined, BlockedDownload[]>(MEDIA_HUB_CHANNELS.downloadBlockedList, () =>
    blockedDownloads()
  )
}

/** Call once, before any window is created. */
export function installDownloadGuard(): void {
  try {
    guardSession(session.defaultSession)
    // Catches partitions and any session Electron creates later — this is
    // what makes the guard actually global rather than "global for the
    // windows that exist right now".
    app.on('session-created', guardSession)
  } catch (error) {
    logError('download:guard', error)
  }
}
