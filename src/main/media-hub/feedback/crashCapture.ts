// The desktop app's crash and hang reports. Installed from main/index.ts
// only: the headless backend has no windows or helper processes to watch.
//
// What is watched, and how it stays out of the way:
//
// - Main-process exceptions through `uncaughtExceptionMonitor`, which
//   OBSERVES without changing what happens next. An 'uncaughtException'
//   listener would swallow Electron's own error dialog and keep a broken
//   process running; the monitor leaves that behaviour exactly as it was.
// - Unhandled promise rejections. Electron already only warns about these,
//   so a listener changes nothing visible; it adds the line to the app log
//   (they were going nowhere before) and reports it.
// - A renderer, the GPU process or another helper dying, and a window
//   stopping responding.
// - Last time not ending cleanly: a marker written at launch and removed
//   on a normal quit. Found at the next launch, it means the app was killed
//   while frozen, crashed too hard to report, or the machine lost power.
//   The log from that session is still on disk, so it goes with the report.

import fs from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { logError } from '../logger'
import { reportProblem, startFeedbackSender } from './reporter'

function markerFile(): string {
  return path.join(app.getPath('userData'), 'feedback', 'running.json')
}

function describe(error: unknown): { title: string; stack?: string } {
  if (error instanceof Error) {
    const kind = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return { title: `${kind}${error.message}`, stack: error.stack }
  }
  return { title: String(error) }
}

function checkLastExit(): void {
  const file = markerFile()
  try {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      startedAt?: string
      version?: string
    }
    const minutes = previous.startedAt
      ? Math.round((Date.now() - Date.parse(previous.startedAt)) / 60_000)
      : -1
    reportProblem({
      kind: 'unclean-exit',
      title: 'The app did not shut down cleanly last time',
      fingerprint: `unclean-exit:${previous.version ?? 'unknown'}`,
      context: { previousVersion: previous.version ?? 'unknown', minutesSinceThatLaunch: minutes },
      withLog: true
    })
  } catch {
    // No marker: last time ended normally (or this is the first launch).
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ startedAt: new Date().toISOString(), version: app.getVersion() })
    )
  } catch {
    // Without a marker the next launch simply cannot tell.
  }
}

function clearMarker(): void {
  try {
    fs.rmSync(markerFile(), { force: true })
  } catch {
    // Reported as unclean next time; harmless.
  }
}

function watchWindow(window: BrowserWindow): void {
  window.on('unresponsive', () => {
    reportProblem({
      kind: 'error',
      title: 'A window stopped responding',
      fingerprint: 'error:window-unresponsive',
      context: { process: 'renderer' },
      withLog: true
    })
  })
}

export function installCrashCapture(): void {
  checkLastExit()
  app.on('will-quit', clearMarker)

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    const { title, stack } = describe(error)
    logError('uncaught', error)
    reportProblem({
      kind: 'crash',
      title,
      stack,
      context: { process: 'main', origin },
      withLog: true
    })
  })

  process.on('unhandledRejection', (reason) => {
    logError('unhandled-rejection', reason)
    const { title, stack } = describe(reason)
    reportProblem({
      kind: 'error',
      title,
      stack,
      context: { process: 'main', origin: 'unhandledRejection' }
    })
  })

  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    reportProblem({
      kind: 'crash',
      title: `A window's renderer went away (${details.reason})`,
      fingerprint: `crash:renderer-${details.reason}`,
      context: {
        process: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
        page: (() => {
          try {
            return new URL(contents.getURL()).hash || '/'
          } catch {
            return 'unknown'
          }
        })()
      },
      withLog: true
    })
  })

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    reportProblem({
      kind: 'crash',
      title: `The ${details.type} process went away (${details.reason})`,
      fingerprint: `crash:${details.type}-${details.reason}`,
      context: {
        process: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name ?? details.serviceName ?? ''
      },
      withLog: true
    })
  })

  app.on('browser-window-created', (_event, window) => watchWindow(window))

  startFeedbackSender()
}
