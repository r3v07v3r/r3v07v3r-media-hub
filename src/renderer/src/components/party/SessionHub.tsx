'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { RoomsSection } from './RoomsSection'
import styles from './SessionHub.module.css'

type PartyTab = 'chat' | 'queue' | 'people'

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The watch party's persistent social surface. It is deliberately
 * route-agnostic: the same conversation and roster stay reachable from
 * discovery, title details, and the player instead of becoming three
 * slightly different party panels.
 *
 * VOCABULARY (deliberate, matches the owner's): a WATCH PARTY is the
 * ephemeral group synced on one film — hosted, joined by invite, gone when
 * everyone leaves. A ROOM is the standing status-sharing group (family,
 * friends) that persists across sessions — see RoomsSection. This panel is
 * the watch party; Rooms live below it when no party is running. */
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<PartyTab>('chat')
  const [draft, setDraft] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  const inParty = partyStatus?.inParty ?? false
  const isHost = partyStatus?.role === 'host'
  const name = nameEdited ?? mediaHubSettings?.partyDisplayName ?? ''
  const partyTitle = playbackMedia?.title ?? partyPreparing?.title ?? 'Watch Party lobby'
  const memberCount = partyStatus?.members?.length ?? 0
  const watcherCount = (partyStatus?.members ?? []).filter(
    (member) => member.watching !== false
  ).length
  // The film this party is on, per the host's own broadcasts — what lets a
  // member who closed their player (or joined into silence) see there is a
  // film to come back to, and ask for it.
  const partyFilm = partyStatus?.nowPlaying ?? null

  useEffect(() => {
    if (tab !== 'chat') return
    chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [partyChat, tab])

  const headerStatus = useMemo(() => {
    if (!inParty) return 'Start a Watch Party or join one with an invite.'
    if (partyPreparing) return `Getting ${partyPreparing.title} ready`
    if (playbackMedia) return `${watcherCount}/${Math.max(memberCount, 1)} ready to watch`
    return 'Choose something together when everyone is here.'
  }, [inParty, memberCount, partyPreparing, playbackMedia, watcherCount])

  function rememberName(value: string): void {
    window.api?.mediaHub?.settings.setPartyDisplayName(value).then(() => refreshMediaHubSettings())
  }

  async function submitParty(): Promise<void> {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (joinCode.trim()) await joinParty(joinCode.trim(), name.trim())
      else await hostParty(name.trim())
      rememberName(name.trim())
      setTab('chat')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open that watch party.')
    } finally {
      setBusy(false)
    }
  }

  async function copyInvite(): Promise<void> {
    if (!partyHostCode) return
    try {
      await window.api?.mediaHub?.clipboard.write(partyHostCode)
      pushNotification({ tone: 'success', message: 'Watch Party invite copied.' })
    } catch {
      pushNotification({ tone: 'error', message: 'Could not copy the invite.' })
    }
  }

  /** "Join the film" — asks the host to replay its nowPlaying to us. The
   *  playback then starts through the exact path a fresh joiner takes. */
  function joinFilm(): void {
    window.api?.mediaHub?.party?.playbackAction({ type: 'resync-request' }).catch(() => {})
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
    <aside className={`${styles.hub} glass-panel`} aria-label="Watch Party" role="dialog">
      <header className={styles.header}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>
            {inParty ? 'Watch Party in progress' : 'Watch together'}
          </span>
          <h2>{inParty ? partyTitle : 'Watch Party'}</h2>
          <p>{headerStatus}</p>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={() => setPartyPanelOpen(false)}
          aria-label="Close Watch Party"
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      {inParty ? (
        <>
          <div className={styles.roomSummary}>
            <span className={styles.liveDot} aria-hidden="true" />
            <span>
              {isHost
                ? 'You are leading this watch party'
                : `Following ${partyStatus?.hostName || 'the host'}`}
            </span>
            {partyHostCode && (
              <button type="button" className={styles.inviteButton} onClick={copyInvite}>
                <Icon name="copy" size={13} /> Invite
              </button>
            )}
          </div>

          {/* The way back into the film for a member who is in the party
              but not watching it — closed their player, or joined while
              the host's announcement never reached them. Rendered from the
              host's own broadcasts, so it exists exactly when there is a
              film to join. */}
          {!isHost && partyFilm && !playbackMedia && !partyPreparing && (
            <button type="button" className={styles.joinFilmButton} onClick={joinFilm}>
              <Icon name="play" size={13} /> Join “{partyFilm.title}” in sync
            </button>
          )}

          {isHost && partyWanAvailable !== null && (
            <p className={partyWanAvailable ? styles.reachabilityGood : styles.reachabilityWarning}>
              {partyWanAvailable
                ? 'Invite works across the internet.'
                : `Local network only. Forward TCP ${partyHostPort ?? 'the party port'} or connect R3 Party Sync in Settings.`}
            </p>
          )}

          <div className={styles.tabs} role="tablist" aria-label="Watch Party sections">
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
            <section className={styles.chatPanel} aria-label="Watch Party chat">
              <div className={styles.messages} aria-live="polite">
                {partyChat.length === 0 ? (
                  <p className={styles.emptyCopy}>
                    The party is quiet. Say hello, coordinate snacks, or decide what plays next.
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
                  placeholder="Message the party"
                  maxLength={1000}
                  aria-label="Message the party"
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
            <section className={styles.peoplePanel} aria-label="People in this watch party">
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
                  <span>Voice stays optional; your party chat remains here.</span>
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
            Leave Watch Party
          </button>
        </>
      ) : (
        <>
          <div className={styles.startCard}>
            <span className={styles.startGlyph}>
              <Icon name="people" size={21} />
            </span>
            <div>
              <strong>One party, wherever you browse</strong>
              <p>Invite people now, then choose a title together from any page.</p>
            </div>
          </div>
          <label className={styles.field}>
            <span>Your display name</span>
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
              placeholder="Paste a Watch Party invite to join"
            />
          </label>
          {/* No Direct/Relay picker any more: hosting opens the direct
              listener always and attaches the relay whenever R3 Party Sync
              is configured, and the one invite code carries both — each
              joiner just uses whichever transport reaches the host first.
              The picker asked a question whose right answer depends on
              where each FUTURE joiner is, which nobody knows at hosting
              time. */}
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void submitParty()}
            disabled={!name.trim() || busy}
          >
            <Icon name={joinCode.trim() ? 'chevron' : 'people'} size={16} />
            {busy ? 'Connecting…' : joinCode.trim() ? 'Join Watch Party' : 'Start a Watch Party'}
          </button>
          <RoomsSection />
        </>
      )}
    </aside>
  )
}
