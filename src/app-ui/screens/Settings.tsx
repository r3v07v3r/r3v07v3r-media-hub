import { useState, type FormEvent } from 'react'
import { api, useAsync } from '../lib/api'
import StatusNote from '../components/StatusNote'
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
    mediaHub.torbox
      .disconnect()
      .then(() => settings.reload())
      .catch(() => {})
  }

  const activeProfile = profiles.data?.profiles.find((p) => p.id === profiles.data?.activeProfileId)

  return (
    <div className="settings-screen">
      <h1>Settings</h1>

      <section className="settings-section">
        <h2>Profile</h2>
        {profiles.loading && <StatusNote>Loading…</StatusNote>}
        {profiles.error && <StatusNote tone="error">Could not load the profile.</StatusNote>}
        {activeProfile && <p>{activeProfile.name}</p>}
      </section>

      <section className="settings-section">
        <h2>TorBox</h2>
        {settings.loading && <StatusNote>Loading…</StatusNote>}
        {settings.error && <StatusNote tone="error">Could not reach the backend.</StatusNote>}
        {settings.data && (
          <p className="settings-status">
            {settings.data.torboxConnected ? 'Connected' : 'Not connected'}
            {settings.data.mediaServerConnected ? ' · Media server connected' : ''}
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
            <button type="submit" disabled={connecting || !token.trim()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        )}
        {connectMessage && <StatusNote>{connectMessage}</StatusNote>}
      </section>

      {settings.data?.appVersion && (
        <p className="settings-version">R3 Media Hub {settings.data.appVersion}</p>
      )}
    </div>
  )
}
