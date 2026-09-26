import { useEffect, useMemo, useState } from 'react'
import { encode } from 'uqr'
import styles from './Settings.module.css'

// The "Link a phone" card: shows a one-time QR code the phone app scans to
// get this computer's services without typing a single key. What the code
// is (a ticket, not the secrets) and what travels is in
// main/media-hub/devicePairingCore.ts; this card only starts a ticket,
// draws it, and watches for it being used.

type PairingState = 'idle' | 'waiting' | 'done' | 'expired' | 'failed' | 'cancelled'

/** The QR as one SVG path, drawn by React rather than injected as markup. */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      })
    )
    return { size: qr.size, path: d }
  }, [text])
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={220}
      height={220}
      role="img"
      aria-label="Pairing code for the phone app"
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 8, display: 'block' }}
    >
      <path d={path} fill="#000" />
    </svg>
  )
}

export function DevicePairingSection() {
  const api = window.api?.mediaHub?.devicePairing
  const [link, setLink] = useState<string | null>(null)
  const [contents, setContents] = useState<string[]>([])
  const [expiresAt, setExpiresAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [state, setState] = useState<PairingState>('idle')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // While a code is on screen: tick the countdown and ask whether it has
  // been used. The ticket is one-shot, so the first answer that is not
  // 'waiting' is final.
  useEffect(() => {
    if (!api || !link) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void api.status().then(({ state: next }) => {
        if (next === 'waiting') return
        setState(next)
        setLink(null)
        if (next === 'done') setMessage({ ok: true, text: 'Phone linked.' })
        else if (next === 'expired') setMessage({ ok: false, text: 'The code expired unused.' })
        else if (next === 'failed')
          setMessage({ ok: false, text: 'Stopped after unexpected requests on the network.' })
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [api, link])

  // Leaving the page takes the code down with it.
  useEffect(() => {
    return () => {
      void window.api?.mediaHub?.devicePairing?.cancel()
    }
  }, [])

  async function handleStart() {
    if (!api) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.start()
      if (!result.ok || !result.link) {
        setMessage({ ok: false, text: result.message ?? 'Could not create a code.' })
        return
      }
      setLink(result.link)
      setContents(result.contents ?? [])
      setExpiresAt(result.expiresAt ?? 0)
      setNow(Date.now())
      setState('waiting')
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (!api) return
    await api.cancel()
    setLink(null)
    setState('cancelled')
  }

  if (!api) return null
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000))

  return (
    <section className={`${styles.section} ${styles.serviceCard} glass-panel`}>
      <div className={styles.serviceHead}>
        <h3 className={styles.serviceName}>Link a phone</h3>
      </div>
      <p className={styles.serviceNote}>
        Sign the R3 phone app in to the same services as this computer. Show a code, scan it with
        the phone’s camera, done. The code works once, for three minutes, on your own Wi-Fi. Trakt
        and MyAnimeList still ask you to sign in on the phone, since they only allow one device per
        sign-in.
      </p>

      {link && state === 'waiting' ? (
        <>
          <div className={styles.row} style={{ alignItems: 'flex-start', gap: 16 }}>
            <QrCode text={link} />
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>Scan with the phone</span>
              <span className={styles.rowDescription}>
                Sends: {contents.join(', ')}.
                <br />
                Expires in {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, '0')}
                .
                <br />
                If Windows asks whether R3 Media Hub may accept connections on private networks,
                allow it: that is the phone reaching this computer.
              </span>
            </div>
          </div>
          <div className={styles.serviceActions}>
            <button type="button" className={styles.testButton} onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className={styles.serviceActions}>
          <button type="button" className={styles.testButton} onClick={handleStart} disabled={busy}>
            {busy ? 'Preparing…' : state === 'done' ? 'Link another phone' : 'Show code'}
          </button>
        </div>
      )}

      {message && (
        <span
          className={`${styles.statusMessage} ${message.ok ? styles.statusOk : styles.statusError}`}
        >
          {message.text}
        </span>
      )}
    </section>
  )
}
