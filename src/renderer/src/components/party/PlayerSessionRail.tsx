'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  PartyChatMessage,
  PartyStatusResult,
  RoomActivity,
  RoomsStatus
} from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './PlayerSessionRail.module.css'

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** A stable two-stop gradient per person, derived from their room identity —
 *  the same member gets the same colour on every device and every session,
 *  with no avatar field on the wire. */
function tintFor(id: string): { from: string; to: string } {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const hue = hash % 360
  return { from: `hsl(${hue} 82% 60%)`, to: `hsl(${(hue + 42) % 360} 82% 48%)` }
}

/** "Dune · 62% in", or "Dune · 34 min in" when their build doesn't announce a
 *  duration, or just "Online" for a member who isn't watching anything. */
function activityTip(name: string, activity: RoomActivity | null): string {
  if (!activity) return `${name} · online`
  let progress: string
  if (activity.duration && activity.duration > 0) {
    const pct = Math.max(0, Math.min(99, Math.round((activity.position / activity.duration) * 100)))
    progress = `${pct}% in`
  } else {
    const minutes = Math.floor((activity.position || 0) / 60)
    progress =
      minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m in` : `${minutes} min in`
  }
  return `${name} · ${activity.title} · ${progress}${activity.paused ? ' · paused' : ''}`
}

/**
 * The standing Rooms, visible WITHOUT leaving the film. Opening the main
 * window's panel hides the whole player (an owned overlay cannot go below
 * its owner), so this strip is the only way to glance at "who's around and
 * what are they watching" mid-film: one row per room, member initials in
 * their stable tints, a hover tooltip with the title and how far in they
 * are. Presence data arrives because rooms.ts pushes its status to this
 * window too — same precedent as the party events.
 */
function RoomsStrip() {
  const [rooms, setRooms] = useState<RoomsStatus | null>(null)

  useEffect(() => {
    const api = window.api?.mediaHub?.rooms
    if (!api) return
    api
      .status()
      .then(setRooms)
      .catch(() => {})
    return api.onEvent(setRooms)
  }, [])

  const visible = (rooms?.rooms ?? []).filter((room) => room.members.length > 0)
  if (!visible.length) return null

  return (
    <div className={styles.roomsBlock} aria-label="Your rooms">
      <span className={styles.roomsHeading}>Your rooms</span>
      {visible.map((room) => (
        <div key={room.roomId} className={styles.roomRow}>
          <span className={styles.roomName}>{room.name}</span>
          <span className={styles.roomAvatars}>
            {room.members.slice(0, 8).map((member) => {
              const tint = tintFor(member.friendId)
              const tip = activityTip(member.name, member.activity)
              return (
                <span key={member.friendId} className={styles.roomAvatarWrap}>
                  <span
                    className={styles.roomAvatar}
                    style={{ background: `linear-gradient(135deg, ${tint.from}, ${tint.to})` }}
                    aria-label={tip}
                  >
                    {member.name.slice(0, 1).toUpperCase()}
                    {member.activity && !member.activity.paused && (
                      <span className={styles.watchingDot} aria-hidden="true" />
                    )}
                  </span>
                  {/* aria-hidden: the accessible name is on the avatar. */}
                  <span className={styles.roomTooltip} aria-hidden="true">
                    {tip}
                  </span>
                </span>
              )
            })}
            {room.members.length > 8 && <em>+{room.members.length - 8}</em>}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A deliberately narrow, player-native counterpart to SessionHub. It talks
 * directly to the party and rooms bridges because the player is a separate
 * Electron renderer; main pushes both event streams to this window too. */
export function PlayerSessionRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<PartyStatusResult | null>(null)
  const [messages, setMessages] = useState<PartyChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const api = window.api?.mediaHub?.party
    if (!api) return
    api
      .status()
      .then(setStatus)
      .catch(() => {})
    return api.onEvent((event) => {
      if (event.type === 'party-state') {
        api
          .status()
          .then(setStatus)
          .catch(() => {})
      } else if (event.type === 'host-disconnected') {
        setStatus({ inParty: false })
      } else if (event.type === 'chat') {
        setMessages((previous) => {
          if (previous.some((message) => message.id === event.chat.id)) return previous
          return [...previous, event.chat].slice(-80)
        })
      }
    })
  }, [open])

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, open])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await window.api?.mediaHub?.party.chat({ id: crypto.randomUUID(), text, sentAt: Date.now() })
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  const members = status?.members ?? []
  const inParty = status?.inParty === true

  return (
    <aside className={styles.rail} aria-label="Watch Party controls">
      <header>
        <div>
          <span className={styles.eyebrow}>{inParty ? 'Watch Party live' : 'No Watch Party'}</span>
          <strong>{inParty ? `${members.length} watching together` : 'Watching solo'}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Watch Party rail">
          <Icon name="x" size={14} />
        </button>
      </header>

      <RoomsStrip />

      {inParty ? (
        <>
          <div className={styles.memberStrip} aria-label="People in this watch party">
            {members.slice(0, 5).map((member) => (
              <span key={member.id} title={`${member.name}${member.isHost ? ' (host)' : ''}`}>
                {member.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {members.length > 5 && <em>+{members.length - 5}</em>}
          </div>
          <div className={styles.messages} aria-live="polite">
            {messages.length === 0 ? (
              <p>
                Chat is ready for this watch. Messages stay in the party and never cover the film.
              </p>
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={message.senderId === status?.selfId ? styles.own : ''}
                >
                  <div>
                    <strong>{message.senderName}</strong>
                    <time>{timeLabel(message.sentAt)}</time>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))
            )}
            <div ref={endRef} />
          </div>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the party"
              maxLength={1000}
            />
            <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">
              <Icon name="chevron" size={14} />
            </button>
          </form>
          <button
            type="button"
            className={styles.discord}
            onClick={() => window.api?.mediaHub?.openExternal('https://discord.com/app')}
          >
            <span>✦</span> Open Discord voice
          </button>
        </>
      ) : (
        <p className={styles.empty}>
          Open the Rooms panel in the app to start or join a Watch Party.
        </p>
      )}
    </aside>
  )
}
