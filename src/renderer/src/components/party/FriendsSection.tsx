'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import type { FriendsStatus } from '@shared/media-hub/types'
import styles from './FriendsSection.module.css'

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

export function FriendsSection() {
  const { pushNotification } = useAppState()
  const [status, setStatus] = useState<FriendsStatus | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)

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
              {/* Joinable only when they're actually hosting something — see
                  FriendActivity.partyCode. Watching alone isn't joinable
                  yet; that flow comes next. */}
              {f.activity?.partyCode ? (
                <button
                  type="button"
                  className={styles.joinButton}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await window.api?.mediaHub?.party.join(f.activity!.partyCode!, '')
                      pushNotification({ tone: 'success', message: `Joined ${f.name}'s party.` })
                    }, 'Could not join that party.')
                  }
                >
                  <Icon name="play" size={12} />
                  Join
                </button>
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
