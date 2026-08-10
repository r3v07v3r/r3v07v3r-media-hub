import { useCallback } from 'react'
import { useOverlayActions } from '@renderer/context/OverlayContext'

export interface AsyncActionOptions<T> {
  action: () => Promise<T>
  errorMessage: string
  successMessage?: string
  /** A stable, non-secret name used in diagnostics. */
  scope: string
  retry?: boolean
}

export type AsyncActionResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Runs a user-triggered async operation with one consistent feedback policy.
 * Media-hub IPC failures are already scope-logged and redacted by ipcGuard in
 * the main process; the renderer diagnostic below adds the UI action name.
 */
export function useAsyncAction() {
  const { pushNotification } = useOverlayActions()

  return useCallback(
    async function runAsyncAction<T>(
      options: AsyncActionOptions<T>
    ): Promise<AsyncActionResult<T>> {
      try {
        const result = await options.action()
        if (options.successMessage) {
          pushNotification({ tone: 'success', message: options.successMessage })
        }
        return { ok: true, value: result }
      } catch (error) {
        console.error(`[action:${options.scope}]`, error)
        const retry = (): void => {
          void runAsyncAction(options)
        }
        pushNotification({
          tone: 'error',
          message: options.errorMessage,
          action: options.retry ? { label: 'Retry', run: retry } : undefined
        })
        return { ok: false }
      }
    },
    [pushNotification]
  )
}
