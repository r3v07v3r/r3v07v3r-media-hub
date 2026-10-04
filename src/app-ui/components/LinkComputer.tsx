import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { requestCatchUp } from '../lib/librarySync'
import { nativeHost } from '../lib/nativeHost'
import Spinner from './Spinner'
import StatusNote from './StatusNote'

/**
 * The phone's half of "Link a phone": takes the code from the desktop's QR
 * and fetches that computer's services.
 *
 * The code carries the key that decrypts those services, so it never travels
 * through a link another app could claim (see devicePairingCore.ts's
 * PAIRING_PREFIX). It arrives one of two ways, both inside this app: the
 * Android app's own scanner (the Scan button), or pasted.
 */
export default function LinkComputer({ onLinked }: { onLinked?: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const host = nativeHost()

  const redeem = useCallback(
    (value: string) => {
      const mediaHub = api()
      const trimmed = value.trim()
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
            setCode('')
            onLinked?.()
            // The services just changed, so this is the moment to fetch what
            // they hold. Forced: a pass that ran a minute ago saw the old
            // accounts (or none), and its report must not stand in for this.
            requestCatchUp({ force: true })
          }
        })
        .catch((error: unknown) => {
          setResult({ ok: false, text: error instanceof Error ? error.message : 'Could not link.' })
        })
        .finally(() => setBusy(false))
    },
    [onLinked]
  )

  // The scanner answers asynchronously, through a window event the Android
  // app dispatches. Scanning was the person's own action in this screen, so
  // a code that comes back is used straight away.
  useEffect(() => {
    const onScan = (event: Event) => {
      setScanning(false)
      const text = (event as CustomEvent<{ text: string | null; error?: string }>).detail
      if (text.text) redeem(text.text)
      else if (text.error) setResult({ ok: false, text: text.error })
    }
    window.addEventListener('r3-scan', onScan)
    return () => window.removeEventListener('r3-scan', onScan)
  }, [redeem])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    redeem(code)
  }

  return (
    <>
      <p className="settings-status">
        On your computer, open the control centre → Media servers → Link a phone → Show code
        {host ? ', then press Scan code here.' : ', then paste the code here.'}
      </p>
      {host && (
        <button
          type="button"
          className="settings-connect"
          disabled={busy || scanning}
          aria-busy={scanning}
          onClick={() => {
            setScanning(true)
            setResult(null)
            host.scanPairingCode()
          }}
        >
          {scanning && <Spinner size="sm" />}
          Scan code
        </button>
      )}
      <form className="settings-form" onSubmit={onSubmit}>
        <input
          type="password"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="R3 PAIR …"
          aria-label="Pairing code"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
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
