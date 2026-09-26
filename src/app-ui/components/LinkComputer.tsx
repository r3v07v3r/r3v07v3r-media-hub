import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import Spinner from './Spinner'
import StatusNote from './StatusNote'

/**
 * The phone's half of "Link a phone": takes the link from the desktop's QR
 * code and fetches that computer's services. Reached two ways — pasted here
 * in Settings, or opened from the camera, which the app shell turns into
 * `#/pair?link=…` and hands over pre-filled. Either way it waits for a tap:
 * a link can come from anywhere, and whose accounts this phone uses is the
 * phone owner's decision.
 */
export default function LinkComputer({
  initialLink = '',
  onLinked
}: {
  initialLink?: string
  onLinked?: () => void
}) {
  const [link, setLink] = useState(initialLink)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const mediaHub = api()
    const trimmed = link.trim()
    if (!mediaHub || !trimmed) return
    setBusy(true)
    setResult(null)
    mediaHub.devicePairing
      .redeem(trimmed)
      .then((answer) => {
        setResult({
          ok: answer.ok,
          text: answer.ok
            ? `${answer.message} Now signed in to: ${(answer.imported ?? []).join(', ')}.`
            : answer.message
        })
        if (answer.ok) {
          setLink('')
          onLinked?.()
        }
      })
      .catch((error: unknown) => {
        setResult({ ok: false, text: error instanceof Error ? error.message : 'Could not link.' })
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <p className="settings-status">
        On your computer, open the control centre → Media servers → Link a phone → Show code, then
        scan it with this phone’s camera. Or paste the link here.
      </p>
      <form className="settings-form" onSubmit={onSubmit}>
        <input
          type="password"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="r3hub://pair?…"
          aria-label="Pairing link"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={busy || !link.trim()}
          aria-busy={busy}
          className="settings-connect"
        >
          {busy && <Spinner size="sm" />}
          {busy ? 'Linking…' : 'Link'}
        </button>
      </form>
      {result && <StatusNote tone={result.ok ? undefined : 'error'}>{result.text}</StatusNote>}
    </>
  )
}
