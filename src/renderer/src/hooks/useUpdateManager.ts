import { useCallback, useSyncExternalStore } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { useAsyncAction } from '@renderer/hooks/useAsyncAction'
import {
  readUpdateStore,
  setUpdateStoreState,
  subscribeToUpdateStore
} from '@renderer/hooks/updateStatusStore'
import type { UpdateChannel, UpdateState, UpdateStatusPayload } from '@shared/media-hub/types'

/** One sentence per state, written to be read by somebody who did not ask
 *  for it — no jargon, no version arithmetic, and never a bare state name. */
export const UPDATE_STATE_LABEL: Record<UpdateState, string> = {
  development: "Auto-update is disabled in development builds — this is what you're running now.",
  checking: 'Checking for updates…',
  available: 'An update is available and downloading…',
  downloading: 'Downloading update…',
  ready: 'Update downloaded — restart to install.',
  current: "You're on the latest version.",
  error: "Couldn't check for updates."
}

export type UpdateTone = 'ok' | 'error' | 'busy' | 'idle'

/** How a state should READ, separate from what it says. Both surfaces colour
 *  from this so a downloading update is never green in one place and grey in
 *  the other. */
export function updateTone(state: UpdateState | undefined): UpdateTone {
  if (!state) return 'idle'
  if (state === 'error') return 'error'
  if (state === 'current' || state === 'ready') return 'ok'
  if (state === 'checking' || state === 'downloading' || state === 'available') return 'busy'
  return 'idle'
}

export interface UpdateManager {
  /** The running build, or undefined before settings have loaded. */
  version?: string
  channel: UpdateChannel
  status: UpdateStatusPayload | null
  /** The running build's own release note. '' for a build made outside the
   *  release workflow, which is normal and renders nothing rather than an
   *  empty heading. */
  notes: string
  /** What the OFFERED version changes, when one is being offered. '' otherwise. */
  offeredNotes: string
  checking: boolean
  /** No preload bridge — running outside the Electron shell, where there is
   *  nothing to update and no honest status to report. */
  bridgeMissing: boolean
  check: () => Promise<void>
  install: () => Promise<void>
  setChannel: (channel: UpdateChannel) => Promise<void>
}

/**
 * Everything the app needs to manage its own updates, in one place.
 *
 * Extracted from the About card the moment updates got a second home: the
 * viewer's settings page and the control centre's Updates section both show
 * this, and two copies of the check/install/channel logic would be two
 * places for the same button to behave differently. The two surfaces differ
 * in presentation only.
 */
export function useUpdateManager(): UpdateManager {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const { status, checking, notes } = useSyncExternalStore(
    subscribeToUpdateStore,
    readUpdateStore,
    readUpdateStore
  )
  const runAction = useAsyncAction()

  const check = useCallback(async () => {
    const api = window.api?.mediaHub
    if (!api) return
    setUpdateStoreState({ checking: true })
    try {
      const result = await api.update.check()
      setUpdateStoreState({ status: { state: result.state, version: result.version } })
    } catch (error) {
      setUpdateStoreState({
        status: {
          state: 'error',
          message: error instanceof Error ? error.message : 'Update check failed.'
        }
      })
    } finally {
      setUpdateStoreState({ checking: false })
    }
  }, [])

  const install = useCallback(async () => {
    const api = window.api?.mediaHub
    if (!api) return
    await runAction({
      scope: 'update.install',
      action: () => api.update.install(),
      errorMessage: "Couldn't restart to install the update.",
      retry: true
    })
  }, [runAction])

  const setChannel = useCallback(
    async (channel: UpdateChannel) => {
      const api = window.api?.mediaHub
      if (!api || channel === mediaHubSettings?.updateChannel) return
      const result = await runAction({
        scope: 'update.set-channel',
        action: () => api.update.setChannel(channel),
        errorMessage: "Couldn't change the update channel.",
        successMessage: `Update channel changed to ${channel}.`,
        retry: true
      })
      if (result.ok) refreshMediaHubSettings()
    },
    [mediaHubSettings?.updateChannel, refreshMediaHubSettings, runAction]
  )

  const offered =
    (status?.state === 'available' || status?.state === 'ready') && status.releaseNotes
      ? status.releaseNotes
      : ''

  return {
    version: mediaHubSettings?.appVersion,
    channel: mediaHubSettings?.updateChannel ?? 'stable',
    status,
    notes,
    offeredNotes: offered,
    checking: checking || status?.state === 'checking',
    bridgeMissing: !window.api?.mediaHub,
    check,
    install,
    setChannel
  }
}

/** The one line the status area shows, assembled the same way wherever it is
 *  shown — label, then the detail that particular state carries. */
export function updateStatusLine(status: UpdateStatusPayload | null): string {
  if (!status) return ''
  let line = UPDATE_STATE_LABEL[status.state]
  if (status.state === 'downloading' && status.percent !== undefined) {
    line += ` ${status.percent}%`
  }
  if ((status.state === 'available' || status.state === 'ready') && status.version) {
    line += ` (v${status.version})`
  }
  if (status.state === 'error' && status.message) line += ` ${status.message}`
  return line
}
