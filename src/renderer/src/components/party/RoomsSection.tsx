'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import type { MediaKind, RoomView, RoomsStatus } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './RoomsSection.module.css'

// A join-request has no wire-level cancel or ack — the only replies are
// 'friend-join-offer'/'friend-join-declined', both dependent on the other
// side's client actually being reachable (found live: it can show online
// from a stale presence row up to the TTL after they've really gone, or
// the relay can drop the message with no NACK). Without this, "Asking…"
// had no way out at all short of closing and reopening the panel. 20s is
// generous for a round trip but short enough that giving up doesn't feel
// like waiting on a hang.
const JOIN_REQUEST_TIMEOUT_MS = 20_000

/** "34 min in" — friendlier than a timestamp for a position someone else
 *  is at, and deliberately coarse: it updates on their announce interval,
 *  so second-level precision would only ever be stale. */
function formatPosition(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m in`
  if (m > 0) return `${m} min in`
  return 'just started'
}

export function RoomsSection() {
  const { pushNotification, joinParty, startPlayback, mediaHubSettings } = useAppState()
  const [status, setStatus] = useState<RoomsStatus | null>(null)
  // Which member's "join or just watch?" choice is currently open. The
  // brief was to ASK each time rather than guess — the two outcomes are
  // genuinely different (locked together vs. watching the same thing
  // independently) and neither is the obvious default.
  const [choosing, setChoosing] = useState<string | null>(null)
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Two-step remove: the first click arms it, the second sends it. A
  // kick rotates the room's keys for everyone — not a thing to do to a
  // family member by misclick.
  const [removing, setRemoving] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [newName, setNewName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const awaitingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAwaitingTimeout = useCallback(() => {
    if (awaitingTimeoutRef.current) {
      clearTimeout(awaitingTimeoutRef.current)
      awaitingTimeoutRef.current = null
    }
  }, [])

  const armAwaitingTimeout = useCallback(
    (friendId: string, friendName: string) => {
      clearAwaitingTimeout()
      awaitingTimeoutRef.current = setTimeout(() => {
        awaitingTimeoutRef.current = null
        setAwaiting((current) => (current === friendId ? null : current))
        pushNotification({ tone: 'warning', message: `${friendName} didn't respond — try again.` })
      }, JOIN_REQUEST_TIMEOUT_MS)
    },
    [clearAwaitingTimeout, pushNotification]
  )

  useEffect(() => clearAwaitingTimeout, [clearAwaitingTimeout])

  // The main process pushes a fresh status on every change (join, leave,
  // presence arriving, someone ageing out), so this doesn't poll.
  useEffect(() => {
    const api = window.api?.mediaHub?.rooms
    if (!api) return
    api
      .status()
      .then(setStatus)
      .catch(() => {})
    return api.onEvent(setStatus)
  }, [])

  // The other half of joining a SOLO watcher: we asked, they spun up a
  // party on demand, and this is the answer coming back.
  useEffect(() => {
    const api = window.api?.mediaHub?.rooms
    if (!api) return
    return api.onMessage(({ message }) => {
      if (message.type === 'friend-join-offer') {
        clearAwaitingTimeout()
        setAwaiting(null)
        joinParty(message.partyCode, mediaHubSettings?.partyDisplayName || 'A friend').catch(() => {
          pushNotification({ tone: 'error', message: 'Could not join that party.' })
        })
      } else if (message.type === 'friend-join-declined') {
        clearAwaitingTimeout()
        setAwaiting(null)
        pushNotification({ tone: 'warning', message: message.reason })
      }
    })
  }, [joinParty, mediaHubSettings, pushNotification, clearAwaitingTimeout])

  const run = useCallback(
    async (fn: () => Promise<unknown>, failure: string) => {
      setBusy(true)
      try {
        await fn()
      } catch (error) {
        pushNotification({
          tone: 'error',
          message: error instanceof Error ? error.message : failure
        })
      } finally {
        setBusy(false)
      }
    },
    [pushNotification]
  )

  if (!status) return null

  const renderRoom = (room: RoomView): React.ReactElement => (
    <div key={room.roomId} className={styles.roomCard}>
      <div className={styles.roomHead}>
        <span className={styles.roomName}>{room.name}</span>
        {room.isAdmin && <span className={styles.adminBadge}>Admin</span>}
        <span
          className={room.connected ? styles.dotOnline : styles.dotOffline}
          title={
            room.connected
              ? room.transport === 'cache-hop'
                ? 'Connected via your cache server — one connection for the whole network'
                : 'Connected to the relay'
              : 'Reconnecting…'
          }
        />
      </div>

      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={room.sharing}
          onChange={(e) =>
            run(
              () => window.api!.mediaHub!.rooms.setSharing(room.roomId, e.target.checked),
              'Could not change sharing.'
            )
          }
        />
        <span>Share what I&apos;m watching here</span>
      </label>

      {room.members.length === 0 ? (
        <p className={styles.hint}>Nobody else is online right now.</p>
      ) : (
        <ul className={styles.friendList}>
          {room.members.map((member) => {
            // Choice state is keyed by room AND member: the same person
            // can be in two of your rooms, and opening the choice on one
            // card must not open it on the other.
            const key = `${room.roomId}:${member.friendId}`
            return (
              <li key={member.friendId} className={styles.friend}>
                <span className={styles.avatar} aria-hidden="true">
                  {member.name.slice(0, 1).toUpperCase()}
                </span>
                <span className={styles.friendText}>
                  <span className={styles.friendName}>{member.name}</span>
                  {member.activity ? (
                    <span className={styles.friendActivity}>
                      {member.activity.title} · {formatPosition(member.activity.position)}
                      {member.activity.paused ? ' · paused' : ''}
                    </span>
                  ) : (
                    <span className={styles.friendIdle}>Not watching anything</span>
                  )}
                </span>
                {room.isAdmin && removing === key ? (
                  <span className={styles.choiceRow}>
                    <button
                      type="button"
                      className={styles.leaveButton}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          setRemoving(null)
                          await window.api!.mediaHub!.rooms.kick(room.roomId, member.friendId)
                          pushNotification({
                            tone: 'success',
                            message: `${member.name} removed — a fresh invite code is on your room.`
                          })
                        }, 'Could not remove them.')
                      }
                    >
                      Really remove
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => setRemoving(null)}
                    >
                      Keep
                    </button>
                  </span>
                ) : member.activity ? (
                  awaiting === key ? (
                    <button
                      type="button"
                      className={styles.awaiting}
                      onClick={() => {
                        clearAwaitingTimeout()
                        setAwaiting(null)
                      }}
                      title="Cancel — no answer yet"
                    >
                      Asking… (cancel)
                    </button>
                  ) : choosing === key ? (
                    <span className={styles.choiceRow}>
                      <button
                        type="button"
                        className={styles.joinButton}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            setChoosing(null)
                            const api = window.api?.mediaHub?.rooms
                            // Already hosting: join straight away. Watching
                            // alone: ask, and they'll create one for us —
                            // without being interrupted; their side answers
                            // with a code and keeps playing.
                            if (member.activity?.partyCode) {
                              await joinParty(
                                member.activity.partyCode,
                                mediaHubSettings?.partyDisplayName || 'A friend'
                              )
                            } else {
                              setAwaiting(key)
                              armAwaitingTimeout(key, member.name)
                              try {
                                await api?.send(room.roomId, {
                                  type: 'friend-join-request',
                                  toFriendId: member.friendId,
                                  fromFriendId: '',
                                  fromName: mediaHubSettings?.partyDisplayName || 'A friend'
                                })
                              } catch (error) {
                                clearAwaitingTimeout()
                                setAwaiting(null)
                                throw error
                              }
                            }
                          }, 'Could not join them.')
                        }
                      >
                        Join them
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            setChoosing(null)
                            // Same title, own playback — nothing synced.
                            const meta = await window.api?.mediaHub?.catalog.meta(
                              (member.activity!.kind || 'movie') as MediaKind,
                              member.activity!.mediaId
                            )
                            if (meta) await startPlayback(catalogItemToMediaItem(meta))
                          }, 'Could not start that title.')
                        }
                      >
                        Watch too
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.joinButton}
                      disabled={busy}
                      onClick={() => setChoosing(key)}
                    >
                      <Icon name="play" size={12} />
                      Watch
                    </button>
                  )
                ) : null}
                {room.isAdmin && removing !== key && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={busy}
                    onClick={() => setRemoving(key)}
                    title="Remove this member from the room"
                  >
                    Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {renaming === room.roomId ? (
        <div className={styles.renameRow}>
          <input
            className={styles.input}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            maxLength={40}
            aria-label="New room name"
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || !renameText.trim()}
            onClick={() =>
              run(async () => {
                await window.api!.mediaHub!.rooms.rename(room.roomId, renameText.trim())
                setRenaming(null)
              }, 'Could not rename the room.')
            }
          >
            Save
          </button>
        </div>
      ) : (
        <div className={styles.roomActions}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={busy}
            onClick={() =>
              run(async () => {
                // The app's own clipboard IPC, not navigator.clipboard: the
                // renderer runs on a custom app:// origin where the browser
                // Clipboard API is denied write permission outright.
                await window.api?.mediaHub?.clipboard.write(room.code)
                pushNotification({ tone: 'success', message: 'Room code copied.' })
              }, 'Could not copy the code.')
            }
          >
            Copy invite
          </button>
          {room.isAdmin && (
            <button
              type="button"
              className={styles.iconButton}
              disabled={busy}
              onClick={() => {
                setRenameText(room.name)
                setRenaming(room.roomId)
              }}
            >
              Rename
            </button>
          )}
          <button
            type="button"
            className={styles.leaveButton}
            disabled={busy}
            onClick={() =>
              run(() => window.api!.mediaHub!.rooms.leave(room.roomId), 'Could not leave.')
            }
          >
            Leave
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Rooms</span>
      </div>
      {status.rooms.length === 0 && (
        <p className={styles.hint}>
          A room is a standing group — family, film friends — where you can see who&apos;s around
          and what they&apos;re watching, and join them without interrupting. Make one and share the
          code, or paste a code to join.
        </p>
      )}

      {status.rooms.map(renderRoom)}

      <div className={styles.joinRow}>
        <input
          className={styles.input}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name a new room"
          maxLength={40}
          aria-label="New room name"
        />
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || !newName.trim()}
          onClick={() =>
            run(async () => {
              const api = window.api?.mediaHub?.rooms
              if (!api) return
              const { code } = await api.create(newName.trim())
              setNewName('')
              await window.api?.mediaHub?.clipboard.write(code)
              pushNotification({ tone: 'success', message: 'Room created — code copied.' })
            }, 'Could not create the room.')
          }
        >
          Create
        </button>
      </div>
      <div className={styles.joinRow}>
        <input
          className={styles.input}
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          placeholder="Paste a room code"
          aria-label="Room code"
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy || !joinCode.trim()}
          onClick={() =>
            run(async () => {
              await window.api?.mediaHub?.rooms.join(joinCode.trim())
              setJoinCode('')
            }, 'Could not join that room.')
          }
        >
          Join
        </button>
      </div>
    </div>
  )
}
