'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './PartyPanel.module.css'

export function PartyPanel() {
  const {
    partyStatus,
    partyQueue,
    partyHostCode,
    partyPanelOpen,
    setPartyPanelOpen,
    hostParty,
    joinParty,
    leaveParty,
    voteQueue,
    removeFromQueue,
    pushNotification
  } = useAppState()

  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!partyPanelOpen) return null

  const inParty = partyStatus?.inParty ?? false
  const isHost = partyStatus?.role === 'host'
  const shareCode = partyHostCode

  async function copyCode() {
    if (!shareCode) return
    try {
      await window.api?.mediaHub?.clipboard.write(shareCode)
      pushNotification({ tone: 'success', message: 'Party code copied.' })
    } catch {
      pushNotification({ tone: 'error', message: 'Could not copy the code.' })
    }
  }

  async function submitHost() {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await hostParty(name.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a party.')
    } finally {
      setBusy(false)
    }
  }

  async function submitJoin() {
    if (!name.trim() || !joinCode.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await joinParty(joinCode.trim(), name.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join that party.')
    } finally {
      setBusy(false)
    }
  }

  async function doLeave() {
    setBusy(true)
    try {
      await leaveParty()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${styles.panel} glass-panel`} role="dialog" aria-label="Watch Party">
      <div className={styles.header}>
        <span className={styles.title}>Watch Party</span>
        <button
          type="button"
          className={styles.closeButton}
          onClick={() => setPartyPanelOpen(false)}
          aria-label="Close Watch Party panel"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {inParty ? (
        <>
          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              {isHost ? 'Hosting' : 'Joined'} as {partyStatus?.selfName}
            </span>
            {shareCode && (
              <div className={styles.codeRow}>
                <span className={styles.code}>{shareCode}</span>
                <button
                  type="button"
                  className={styles.copyButton}
                  onClick={copyCode}
                  aria-label="Copy party code"
                >
                  <Icon name="copy" size={13} />
                </button>
              </div>
            )}
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              Members {partyStatus?.members?.length ? `(${partyStatus.members.length})` : ''}
            </span>
            <ul className={styles.memberList}>
              {(partyStatus?.members ?? []).map((m) => (
                <li key={m.id} className={styles.memberRow}>
                  <span className={styles.memberDot} aria-hidden="true" />
                  <span className={styles.memberName}>{m.name}</span>
                  {m.isHost && <span className={styles.hostBadge}>Host</span>}
                </li>
              ))}
            </ul>
          </div>

          {partyQueue.length > 0 && (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Suggested</span>
              <ul className={styles.queueList}>
                {partyQueue.map((entry) => {
                  const score = Object.values(entry.votes).reduce((sum, v) => sum + v, 0)
                  return (
                    <li key={entry.queueId} className={styles.queueRow}>
                      <span className={styles.queueTitle}>{entry.item.title}</span>
                      <div className={styles.queueActions}>
                        <button
                          type="button"
                          className={styles.voteButton}
                          onClick={() => voteQueue(entry.queueId, 1)}
                          aria-label="Vote up"
                        >
                          <Icon name="thumbs-up" size={12} />
                        </button>
                        <span className={styles.queueScore}>{score}</span>
                        <button
                          type="button"
                          className={styles.voteButton}
                          onClick={() => voteQueue(entry.queueId, -1)}
                          aria-label="Vote down"
                        >
                          <Icon name="thumbs-down" size={12} />
                        </button>
                        {isHost && (
                          <button
                            type="button"
                            className={styles.voteButton}
                            onClick={() => removeFromQueue(entry.queueId)}
                            aria-label="Remove suggestion"
                          >
                            <Icon name="x" size={12} />
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <button type="button" className={styles.leaveButton} onClick={doLeave} disabled={busy}>
            Leave party
          </button>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Your name</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Party code (to join one)</span>
            <input
              className={styles.fieldInput}
              type="text"
              placeholder="Leave blank to host instead"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
          </label>
          {error && <span className={styles.error}>{error}</span>}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={joinCode.trim() ? submitJoin : submitHost}
            disabled={!name.trim() || busy}
          >
            <Icon name="people" size={13} />
            {busy ? 'Working…' : joinCode.trim() ? 'Join party' : 'Host a party'}
          </button>
        </>
      )}
    </div>
  )
}
