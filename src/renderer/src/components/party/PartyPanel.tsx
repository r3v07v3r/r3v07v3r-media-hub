'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { FriendsSection } from './FriendsSection'
import styles from './PartyPanel.module.css'

export function PartyPanel() {
  const {
    partyStatus,
    partyQueue,
    partyHostCode,
    partyWanAvailable,
    partyHostPort,
    partyPanelOpen,
    setPartyPanelOpen,
    mediaHubSettings,
    refreshMediaHubSettings,
    hostParty,
    joinParty,
    leaveParty,
    voteQueue,
    removeFromQueue,
    requestPartyPlay,
    setPartyMemberControl,
    pushNotification
  } = useAppState()

  const [nameEdited, setNameEdited] = useState<string | null>(null)
  const name = nameEdited ?? mediaHubSettings?.partyDisplayName ?? ''
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

  function rememberName(value: string): void {
    window.api?.mediaHub?.settings.setPartyDisplayName(value).then(() => refreshMediaHubSettings())
  }

  async function submitHost() {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await hostParty(name.trim())
      rememberName(name.trim())
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
      rememberName(name.trim())
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
            {/* Only known right after hosting (see AppStateContext's
                partyWanAvailable) — this is the actual, honest answer to
                "will this work for someone outside my network," disclosed
                upfront instead of only surfacing as a mystery timeout on
                the other end once someone tries and fails to join. */}
            {isHost && partyWanAvailable !== null && (
              <span
                className={partyWanAvailable ? styles.reachabilityGood : styles.reachabilityWarning}
              >
                {partyWanAvailable
                  ? 'Reachable over the internet — anyone with this code can join.'
                  : `Only reachable on your own network — your router didn't open a port automatically. Forward port ${partyHostPort ?? '(shown when hosting)'} (TCP) to this PC to allow joining from elsewhere, or make sure whoever's joining is on the same Wi-Fi/network as you.`}
              </span>
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
            {isHost && (
              <label className={styles.memberControlToggle}>
                <input
                  type="checkbox"
                  checked={Boolean(partyStatus?.allowMemberControl)}
                  onChange={(e) => setPartyMemberControl(e.target.checked)}
                />
                Anyone can control playback
              </label>
            )}
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
                          onClick={() => requestPartyPlay(entry.item)}
                          aria-label={`Play ${entry.item.title}`}
                        >
                          <Icon name="play" size={12} />
                        </button>
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
              onChange={(e) => setNameEdited(e.target.value)}
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
      {/* Friends live alongside the party rather than in Settings: the two
          are the same social surface, and joining a friend IS starting a
          party. */}
      <FriendsSection />
    </div>
  )
}
