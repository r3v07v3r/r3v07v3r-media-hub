import { useState, type FormEvent } from 'react'
import { api, useAsync } from '../lib/api'
import Spinner from '../components/Spinner'
import StatusNote from '../components/StatusNote'
import LinkComputer from '../components/LinkComputer'
import { useCatchUp } from '../lib/librarySync'
import './Settings.css'

export default function Settings() {
  const settings = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.settings.get()
  }, [])
  const profiles = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.profiles.list()
  }, [])

  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectMessage, setConnectMessage] = useState<string | null>(null)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  // The phone holds no Simkl status of its own; the newest catch-up report
  // is what knows. On a phone the only tracking service is Simkl (linking
  // brings no other), so "connected" there is Simkl. A report with no `at`
  // knows nothing, so it is read as no answer yet.
  const catchUp = useCatchUp()
  const catchUpReport = catchUp.report
  const trackingReport = catchUpReport && catchUpReport.at > 0 ? catchUpReport : null
  // Before the first real report the phone cannot tell linked from not, so
  // it says nothing it may have to take back. A no-pass answer (`at` 0)
  // still carries whether any account is held, which is enough for the line.
  const simklKnown = trackingReport ?? catchUpReport

  const onConnect = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = token.trim()
    const mediaHub = api()
    if (!mediaHub || !trimmed) return
    setConnecting(true)
    setConnectMessage(null)
    mediaHub.torbox
      .connect(trimmed)
      .then((result) => {
        setConnectMessage(
          result.ok ? 'Connected to TorBox.' : (result.message ?? 'Could not connect.')
        )
        settings.reload()
      })
      .catch((error: unknown) => {
        setConnectMessage(error instanceof Error ? error.message : 'Could not connect.')
      })
      .finally(() => {
        // Never echoed back, and cleared whether the connect worked or not.
        setToken('')
        setConnecting(false)
      })
  }

  const onDisconnect = () => {
    const mediaHub = api()
    if (!mediaHub) return
    setDisconnectError(null)
    mediaHub.torbox
      .disconnect()
      .then(() => settings.reload())
      .catch((error: unknown) => {
        setDisconnectError(error instanceof Error ? error.message : 'Could not disconnect TorBox.')
      })
  }

  const activeProfile = profiles.data?.profiles.find((p) => p.id === profiles.data?.activeProfileId)

  return (
    <div className="settings-screen" aria-busy={settings.loading || profiles.loading || connecting}>
      <h1>Settings</h1>

      <section className="settings-section">
        <h2>Profile</h2>
        {profiles.loading && (
          <div className="settings-status-loading">
            <Spinner size="sm" />
            <StatusNote>Loading…</StatusNote>
          </div>
        )}
        {profiles.error && <StatusNote tone="error">Could not load the profile.</StatusNote>}
        {activeProfile && <p>{activeProfile.name}</p>}
      </section>

      <section className="settings-section">
        <h2>Your computer</h2>
        <LinkComputer
          onLinked={() => {
            settings.reload()
            profiles.reload()
          }}
        />
        {simklKnown ? (
          <p className="settings-status">
            {simklKnown.signedOut
              ? 'Simkl: signed out. Reconnect Simkl on your computer, then link this device again.'
              : simklKnown.connected
                ? 'Simkl: linked from your computer'
                : 'Simkl lists arrive when you link your computer.'}
          </p>
        ) : (
          catchUp.inFlight && <p className="settings-status">Checking Simkl…</p>
        )}
        {/* A media server is not in what linking brings over
            (devicePairingCore.ts's PairingBundle), and this app has nowhere
            to set one up, so the line says so rather than promising a link
            will fix it. */}
        {settings.data && (
          <p className="settings-status">
            {settings.data.mediaServerConnected
              ? 'Media server: connected'
              : 'Media server: not set up. Linking your computer does not bring one over, and this device cannot set one up yet.'}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>TorBox</h2>
        {settings.loading && (
          <div className="settings-status-loading">
            <Spinner size="sm" />
            <StatusNote>Loading…</StatusNote>
          </div>
        )}
        {settings.error && <StatusNote tone="error">Could not reach the backend.</StatusNote>}
        {settings.data && (
          <p className="settings-status">
            {settings.data.torboxConnected ? 'Connected' : 'Not connected'}
          </p>
        )}
        {settings.data?.torboxConnected ? (
          <button type="button" onClick={onDisconnect}>
            Disconnect TorBox
          </button>
        ) : (
          <form className="settings-form" onSubmit={onConnect}>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="TorBox API token"
              aria-label="TorBox API token"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={connecting || !token.trim()}
              aria-busy={connecting}
              className="settings-connect"
            >
              {connecting && <Spinner size="sm" />}
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        )}
        {connectMessage && <StatusNote>{connectMessage}</StatusNote>}
        {disconnectError && <StatusNote tone="error">{disconnectError}</StatusNote>}
      </section>

      {settings.data?.appVersion && (
        <p className="settings-version">R3 Media Hub {settings.data.appVersion}</p>
      )}
    </div>
  )
}
