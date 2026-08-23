'use client'

import { useEffect, useRef, useState } from 'react'
import type { PartyChatMessage, PartyStatusResult } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './PlayerSessionRail.module.css'

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** A deliberately narrow, player-native counterpart to SessionHub. It talks
 * directly to the party bridge because the player is a separate Electron
 * renderer, while all room events are now sent to both windows. */
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
  const inRoom = status?.inParty === true

  return (
    <aside className={styles.rail} aria-label="Room controls">
      <header>
        <div>
          <span className={styles.eyebrow}>{inRoom ? 'Room live' : 'Room unavailable'}</span>
          <strong>{inRoom ? `${members.length} watching together` : 'Not in a room'}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close room rail">
          <Icon name="x" size={14} />
        </button>
      </header>

      {inRoom ? (
        <>
          <div className={styles.memberStrip} aria-label="People in this room">
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
                Chat is ready for this watch. Messages stay in the room and never cover the film.
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
              placeholder="Message the room"
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
        <p className={styles.empty}>Open Rooms in the app navigation to host or join a watch.</p>
      )}
    </aside>
  )
}
