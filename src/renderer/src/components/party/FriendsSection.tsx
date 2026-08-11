'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import type { MediaKind } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import type { FriendsStatus } from '@shared/media-hub/types'
import styles from './FriendsSection.module.css'

/** "34 min in" — friendlier than a timestamp for a position someone else
 *  is at, and deliberately coarse: it updates on their announce interval,
 *  so second-level precision would only ever be stale. */
// A friend-join-request has no wire-level cancel or ack — the only replies
// are 'friend-join-offer'/'friend-join-declined', both dependent on the
// other side's client actually being reachable (found live: it can show
// online from a stale presence row up to PRESENCE_TTL_MS after they've
// really gone, or the relay can drop the message with no NACK). Without
// this, "Asking…" had no way out at all short of closing and reopening the
// panel. 20s is generous for a same-network round trip but short enough
// that giving up doesn't feel like waiting on a hang.
const FRIEND_JOIN_REQUEST_TIMEOUT_MS = 20_000

function formatPosition(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m in`
  if (m > 0) return `${m} min in`
  return 'just started'
}

export function FriendsSection() {
  const { pushNotification, joinParty, startPlayback, mediaHubSettings } = useAppState()
  // Which friend's "join or just watch?" choice is currently open. The
  // brief was to ASK each time rather than guess — the two outcomes are
  // genuinely different (locked together vs. watching the same thing
  // independently) and neither is the obvious default.
  const [choosing, setChoosing] = useState<string | null>(null)
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const [status, setStatus] = useState<FriendsStatus | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const awaitingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAwaitingTimeout = useCallback(() => {
    if (awaitingTimeoutRef.current) {
      clearTimeout(awaitingTimeoutRef.current)
      awaitingTimeoutRef.current = null
    }
  }, [])

  // Safety net for a request nobody ever answers — see
  // FRIEND_JOIN_REQUEST_TIMEOUT_MS's own comment.
  const armAwaitingTimeout = useCallback(
    (friendId: string, friendName: string) => {
      clearAwaitingTimeout()
      awaitingTimeoutRef.current = setTimeout(() => {
        awaitingTimeoutRef.current = null
        setAwaiting((current) => (current === friendId ? null : current))
        pushNotification({ tone: 'warning', message: `${friendName} didn't respond — try again.` })
      }, FRIEND_JOIN_REQUEST_TIMEOUT_MS)
    },
    [clearAwaitingTimeout, pushNotification]
  )

  useEffect(() => clearAwaitingTimeout, [clearAwaitingTimeout])

  // The main process pushes a fresh status on every change (join, leave,
  // presence arriving, someone ageing out), so this doesn't poll.
  useEffect(() => {
    const api = window.api?.mediaHub?.friends
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
    const api = window.api?.mediaHub?.friends
    if (!api) return
    return api.onMessage((message) => {
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

  if (!status.inGroup) {
    return (
      <div className={styles.section}>
        <span className={styles.sectionLabel}>Friends</span>
        <p className={styles.hint}>
          Create a group and share the code, or paste a friend&apos;s code to join theirs. You stay
          connected in the background and can see what everyone&apos;s watching.
        </p>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy}
          onClick={() =>
            run(async () => {
              const api = window.api?.mediaHub?.friends
              if (!api) return
              const { code } = await api.create()
              // The app's own clipboard IPC, not navigator.clipboard: the
              // renderer runs on a custom app:// origin where the browser
              // Clipboard API is denied write permission outright ("Write
              // permission denied"). PartyPanel's own copy button uses the
              // same IPC.
              await window.api?.mediaHub?.clipboard.write(code)
              pushNotification({ tone: 'success', message: 'Group created — code copied.' })
            }, 'Could not create the group.')
          }
        >
          Create a group
        </button>
        <div className={styles.joinRow}>
          <input
            className={styles.input}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Paste a group code"
            aria-label="Group code"
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || !joinCode.trim()}
            onClick={() =>
              run(async () => {
                await window.api?.mediaHub?.friends.join(joinCode.trim())
                setJoinCode('')
              }, 'Could not join that group.')
            }
          >
            Join
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Friends</span>
        <span
          className={status.connected ? styles.dotOnline : styles.dotOffline}
          aria-hidden="true"
        />
        <span className={styles.connState}>{status.connected ? 'Connected' : 'Reconnecting…'}</span>
      </div>

      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={status.sharing}
          onChange={(e) =>
            run(
              () => window.api!.mediaHub!.friends.setSharing(e.target.checked),
              'Could not change sharing.'
            )
          }
        />
        <span>Share what I&apos;m watching</span>
      </label>

      {status.friends.length === 0 ? (
        <p className={styles.hint}>Nobody else is online right now.</p>
      ) : (
        <ul className={styles.friendList}>
          {status.friends.map((f) => (
            <li key={f.friendId} className={styles.friend}>
              <span className={styles.avatar} aria-hidden="true">
                {f.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={styles.friendText}>
                <span className={styles.friendName}>{f.name}</span>
                {f.activity ? (
                  <span className={styles.friendActivity}>
                    {f.activity.title} · {formatPosition(f.activity.position)}
                    {f.activity.paused ? ' · paused' : ''}
                  </span>
                ) : (
                  <span className={styles.friendIdle}>Not watching anything</span>
                )}
              </span>
              {f.activity ? (
                awaiting === f.friendId ? (
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
                ) : choosing === f.friendId ? (
                  <span className={styles.choiceRow}>
                    <button
                      type="button"
                      className={styles.joinButton}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          setChoosing(null)
                          const api = window.api?.mediaHub?.friends
                          // Already hosting: join straight away. Watching
                          // alone: ask, and they'll create one for us.
                          if (f.activity?.partyCode) {
                            await joinParty(
                              f.activity.partyCode,
                              mediaHubSettings?.partyDisplayName || 'A friend'
                            )
                          } else {
                            setAwaiting(f.friendId)
                            armAwaitingTimeout(f.friendId, f.name)
                            try {
                              await api?.send({
                                type: 'friend-join-request',
                                toFriendId: f.friendId,
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
                      Join party
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
                            (f.activity!.kind || 'movie') as MediaKind,
                            f.activity!.mediaId
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
                    onClick={() => setChoosing(f.friendId)}
                  >
                    <Icon name="play" size={12} />
                    Watch
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.footerRow}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          onClick={() =>
            run(async () => {
              await window.api?.mediaHub?.clipboard.write(status.code || '')
              pushNotification({ tone: 'success', message: 'Group code copied.' })
            }, 'Could not copy the code.')
          }
        >
          Copy group code
        </button>
        <button
          type="button"
          className={styles.leaveButton}
          disabled={busy}
          onClick={() => run(() => window.api!.mediaHub!.friends.leave(), 'Could not leave.')}
        >
          Leave
        </button>
      </div>
    </div>
  )
}
