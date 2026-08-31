'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { RoomsSection } from './RoomsSection'
import styles from './SessionHub.module.css'

type RoomTab = 'chat' | 'queue' | 'people'

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The room's persistent social surface. It is deliberately route-agnostic:
 * the same conversation and roster stay reachable from discovery, title
 * details, and the player instead of becoming three slightly different party
 * panels. */
export function SessionHub() {
  const {
    partyStatus,
    partyQueue,
    partyChat,
    partyHostCode,
    partyWanAvailable,
    partyHostPort,
    partyPanelOpen,
    setPartyPanelOpen,
    mediaHubSettings,
    refreshMediaHubSettings,
    playbackMedia,
    partyPreparing,
    hostParty,
    joinParty,
    leaveParty,
    voteQueue,
    removeFromQueue,
    requestPartyPlay,
    setPartyMemberControl,
    sendPartyChat,
    pushNotification
  } = useAppState()

  const [nameEdited, setNameEdited] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [mode, setMode] = useState<'direct' | 'relay'>('direct')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<RoomTab>('chat')
  const [draft, setDraft] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  const inRoom = partyStatus?.inParty ?? false
  const isHost = partyStatus?.role === 'host'
  const name = nameEdited ?? mediaHubSettings?.partyDisplayName ?? ''
  const roomTitle = playbackMedia?.title ?? partyPreparing?.title ?? 'Room lobby'
  const memberCount = partyStatus?.members?.length ?? 0
  const watcherCount = (partyStatus?.members ?? []).filter(
    (member) => member.watching !== false
  ).length
  const canUseRelay = Boolean(mediaHubSettings?.partySyncUrl)

  useEffect(() => {
    if (tab !== 'chat') return
    chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [partyChat, tab])

  const headerStatus = useMemo(() => {
    if (!inRoom) return 'Make a room or join one with an invite.'
    if (partyPreparing) return `Getting ${partyPreparing.title} ready`
    if (playbackMedia) return `${watcherCount}/${Math.max(memberCount, 1)} ready to watch`
    return 'Choose something together when everyone is here.'
  }, [inRoom, memberCount, partyPreparing, playbackMedia, watcherCount])

  function rememberName(value: string): void {
    window.api?.mediaHub?.settings.setPartyDisplayName(value).then(() => refreshMediaHubSettings())
  }

  async function submitRoom(): Promise<void> {
    if (!name.trim() || busy) return
    if (mode === 'relay' && !canUseRelay) {
      setError('Connect R3 Party Sync in Settings before hosting a relay room.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (joinCode.trim()) await joinParty(joinCode.trim(), name.trim())
      else await hostParty(name.trim(), mode)
      rememberName(name.trim())
      setTab('chat')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open that room.')
    } finally {
      setBusy(false)
    }
  }

  async function copyInvite(): Promise<void> {
    if (!partyHostCode) return
    try {
      await window.api?.mediaHub?.clipboard.write(partyHostCode)
      pushNotification({ tone: 'success', message: 'Room invite copied.' })
    } catch {
      pushNotification({ tone: 'error', message: 'Could not copy the invite.' })
    }
  }

  async function sendMessage(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await sendPartyChat(text)
      setDraft('')
    } catch (reason) {
      pushNotification({
        tone: 'error',
        message: reason instanceof Error ? reason.message : 'Could not send that message.'
      })
    } finally {
      setBusy(false)
    }
  }

  if (!partyPanelOpen) return null

  return (
    <aside className={`${styles.hub} glass-panel`} aria-label="Rooms" role="dialog">
      <header className={styles.header}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>{inRoom ? 'Room in progress' : 'Watch together'}</span>
          <h2>{inRoom ? roomTitle : 'Rooms'}</h2>
          <p>{headerStatus}</p>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={() => setPartyPanelOpen(false)}
          aria-label="Close Rooms"
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      {inRoom ? (
        <>
          <div className={styles.roomSummary}>
            <span className={styles.liveDot} aria-hidden="true" />
            <span>
              {isHost
                ? 'You are leading this room'
                : `Following ${partyStatus?.hostName || 'the host'}`}
            </span>
            {partyHostCode && (
              <button type="button" className={styles.inviteButton} onClick={copyInvite}>
                <Icon name="copy" size={13} /> Invite
              </button>
            )}
          </div>

          {isHost && partyWanAvailable !== null && (
            <p className={partyWanAvailable ? styles.reachabilityGood : styles.reachabilityWarning}>
              {partyWanAvailable
                ? 'Invite works across the internet.'
                : `Local network only. Forward TCP ${partyHostPort ?? 'the room port'} or use relay hosting.`}
            </p>
          )}

          <div className={styles.tabs} role="tablist" aria-label="Room sections">
            {(
              [
                ['chat', 'Chat'],
                ['queue', `Queue${partyQueue.length ? ` ${partyQueue.length}` : ''}`],
                ['people', `People ${memberCount}`]
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={tab === key ? styles.tabActive : styles.tab}
                onClick={() => setTab(key)}
                role="tab"
                aria-selected={tab === key}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'chat' && (
            <section className={styles.chatPanel} aria-label="Room chat">
              <div className={styles.messages} aria-live="polite">
                {partyChat.length === 0 ? (
                  <p className={styles.emptyCopy}>
                    The room is quiet. Say hello, coordinate snacks, or decide what plays next.
                  </p>
                ) : (
                  partyChat.map((message) => (
                    <article
                      key={message.id}
                      className={
                        message.senderId === partyStatus?.selfId
                          ? styles.ownMessage
                          : styles.message
                      }
                    >
                      <div className={styles.messageMeta}>
                        <strong>{message.senderName}</strong>
                        <time>{formatTime(message.sentAt)}</time>
                      </div>
                      <p>{message.text}</p>
                    </article>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
              <form
                className={styles.messageComposer}
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendMessage()
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Message the room"
                  maxLength={1000}
                  aria-label="Message the room"
                />
                <button type="submit" disabled={!draft.trim() || busy} aria-label="Send message">
                  <Icon name="chevron" size={15} />
                </button>
              </form>
            </section>
          )}

          {tab === 'queue' && (
            <section className={styles.queuePanel} aria-label="Shared queue">
              {partyQueue.length === 0 ? (
                <p className={styles.emptyCopy}>
                  Suggestions from title pages appear here for everyone.
                </p>
              ) : (
                <ul className={styles.queueList}>
                  {partyQueue.map((entry) => {
                    const score = Object.values(entry.votes).reduce(
                      (total, vote) => total + vote,
                      0
                    )
                    return (
                      <li key={entry.queueId} className={styles.queueItem}>
                        <div>
                          <strong>{entry.item.title}</strong>
                          <span>Suggested by {entry.suggestedBy}</span>
                        </div>
                        <div className={styles.queueActions}>
                          <button
                            type="button"
                            onClick={() => requestPartyPlay(entry.item)}
                            aria-label={`Play ${entry.item.title}`}
                          >
                            <Icon name="play" size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => voteQueue(entry.queueId, 1)}
                            aria-label="Vote up"
                          >
                            <Icon name="thumbs-up" size={12} />
                          </button>
                          <span>{score}</span>
                          <button
                            type="button"
                            onClick={() => voteQueue(entry.queueId, -1)}
                            aria-label="Vote down"
                          >
                            <Icon name="thumbs-down" size={12} />
                          </button>
                          {isHost && (
                            <button
                              type="button"
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
              )}
            </section>
          )}

          {tab === 'people' && (
            <section className={styles.peoplePanel} aria-label="People in this room">
              <ul className={styles.memberList}>
                {(partyStatus?.members ?? []).map((member) => (
                  <li key={member.id}>
                    <span
                      className={member.watching === false ? styles.idleDot : styles.memberDot}
                    />
                    <span className={styles.memberAvatar}>
                      {member.name.slice(0, 1).toUpperCase()}
                    </span>
                    <strong>{member.name}</strong>
                    {member.isHost && <span className={styles.hostTag}>Host</span>}
                    <span className={styles.memberState}>
                      {member.watching === false ? 'browsing' : 'ready'}
                    </span>
                  </li>
                ))}
              </ul>
              {isHost && (
                <label className={styles.controlToggle}>
                  <input
                    type="checkbox"
                    checked={Boolean(partyStatus?.allowMemberControl)}
                    onChange={(event) => setPartyMemberControl(event.target.checked)}
                  />
                  <span>Everyone can control playback</span>
                </label>
              )}
              <div className={styles.discordCard}>
                <div className={styles.discordMark}>✦</div>
                <div>
                  <strong>Discord voice</strong>
                  <span>Voice stays optional; your room chat remains here.</span>
                </div>
                <button
                  type="button"
                  onClick={() => window.api?.mediaHub?.openExternal('https://discord.com/app')}
                >
                  Open Discord
                </button>
              </div>
            </section>
          )}

          <button
            type="button"
            className={styles.leaveButton}
            onClick={() => void leaveParty()}
            disabled={busy}
          >
            Leave room
          </button>
        </>
      ) : (
        <>
          <div className={styles.startCard}>
            <span className={styles.startGlyph}>
              <Icon name="people" size={21} />
            </span>
            <div>
              <strong>One room, wherever you browse</strong>
              <p>Invite people now, then choose a title together from any page.</p>
            </div>
          </div>
          <label className={styles.field}>
            <span>Your room name</span>
            <input
              value={name}
              onChange={(event) => setNameEdited(event.target.value)}
              placeholder="How friends see you"
            />
          </label>
          <label className={styles.field}>
            <span>
              Invite code <em>optional</em>
            </span>
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="Paste a room invite to join"
            />
          </label>
          {!joinCode.trim() && (
            <div className={styles.modePicker} aria-label="Room connection">
              <button
                type="button"
                className={mode === 'direct' ? styles.modeActive : ''}
                onClick={() => setMode('direct')}
              >
                Direct
                <small>Best on one network</small>
              </button>
              <button
                type="button"
                className={mode === 'relay' ? styles.modeActive : ''}
                onClick={() => setMode('relay')}
                disabled={!canUseRelay}
                title={
                  canUseRelay
                    ? 'Use R3 Party Sync relay'
                    : 'Configure R3 Party Sync in Settings first'
                }
              >
                Relay
                <small>Works across networks</small>
              </button>
            </div>
          )}
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void submitRoom()}
            disabled={!name.trim() || busy}
          >
            <Icon name={joinCode.trim() ? 'chevron' : 'people'} size={16} />
            {busy ? 'Connecting…' : joinCode.trim() ? 'Join room' : 'Start a room'}
          </button>
          <RoomsSection />
        </>
      )}
    </aside>
  )
}
