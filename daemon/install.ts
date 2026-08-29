// One-time auto-start registration — the "get all permissions during
// first set up" half of the deal. Everything the daemon will ever need is
// user-scoped (user-writable data dir, user-level start entry, no
// privileged ports), so this runs WITHOUT elevation and updates never ask
// for anything again: they are just files written into the user's own
// versions/ directory and a restart the service manager already permits.
//
//   r3-cache --install     register auto-start for the current user
//   r3-cache --uninstall   remove it
//
// Windows: a per-user logon Scheduled Task (no admin required, unlike a
// Windows Service). Linux: a systemd user unit, enabled, with linger so
// it runs without a login session. Both point at THIS executable/bundle;
// updates never touch the registration, because what updates is the
// staged payload the launcher picks, not the file the OS starts.

import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const TASK_NAME = 'r3-cache'
const UNIT_NAME = 'r3-cache.service'

function entryCommand(): { program: string; args: string[] } {
  // A SEA executable IS node, so execPath alone runs it. A plain-node run
  // (node r3-cache.cjs / tsx daemon/main.ts) needs the script argument.
  const script = process.argv[1] ? path.resolve(process.argv[1]) : ''
  const isSea = !script || path.resolve(process.execPath) === script
  return isSea
    ? { program: process.execPath, args: [] }
    : { program: process.execPath, args: [script] }
}

export async function installAutoStart(log: (message: string) => void): Promise<void> {
  const { program, args } = entryCommand()

  if (process.platform === 'win32') {
    // Quoting each part individually: an unquoted path under
    // "C:\Program Files\..." would be split at the space and schtasks
    // would register a command that cannot run.
    const command = [program, ...args].map((part) => `"${part}"`).join(' ')
    execFileSync(
      'schtasks',
      ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', command],
      { stdio: 'inherit' }
    )
    // The rollback design needs a supervisor: a payload that dies hard
    // must be restarted so the launcher's tripwire can count the failed
    // boot and fall back. ONLOGON alone only ever starts it once, which
    // left Windows with no rollback at all — the contract held on Linux
    // and quietly did not here. /RI restarts the task if it stops.
    try {
      execFileSync('schtasks', ['/Change', '/TN', TASK_NAME, '/RI', '1', '/DU', '9999:59'], {
        stdio: 'inherit'
      })
      log('registered a restart interval so a crashed daemon comes back')
    } catch {
      log('WARNING: could not set a restart interval — a hard crash will')
      log('         need a fresh logon to recover on this machine')
    }
    log(`registered logon task "${TASK_NAME}" -> ${command}`)
    log('r3-cache will start automatically when you log in.')
    log('Open the app on this network to claim and join it.')
    return
  }

  if (process.platform !== 'linux') {
    // macOS took the Linux branch and wrote a systemd unit into ~/.config
    // before failing on a missing systemctl — leaving a file that does
    // nothing and an error that explains nothing.
    throw new Error(
      `--install supports Windows and Linux; on ${process.platform} run the daemon yourself ` +
        '(a launchd plist is not generated).'
    )
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  await fsp.mkdir(unitDir, { recursive: true })
  // systemd splits ExecStart on whitespace unless quoted, so a path
  // containing a space produced a unit that silently never started.
  const execStart = [program, ...args].map((part) => `"${part}"`).join(' ')
  const unit = `[Unit]
Description=r3-cache pre-fetch daemon
After=network.target

[Service]
ExecStart=${execStart}
# The launcher handles rollback; systemd handles resurrection. Together:
# a bad update boots, trips, gets marked bad, and the previous good
# version comes back — "it always comes back online".
Restart=always
RestartSec=5
# Deliberately generous: the launcher's own backoff and blacklist are the
# real circuit breaker, and a unit that gives up entirely (systemd's
# default start limit) is a daemon that is permanently offline — the one
# outcome this whole design exists to prevent.
StartLimitIntervalSec=0
MemoryMax=512M
Nice=10
CPUWeight=20
NoNewPrivileges=true

[Install]
WantedBy=default.target
`
  await fsp.writeFile(path.join(unitDir, UNIT_NAME), unit)
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  execFileSync('systemctl', ['--user', 'enable', '--now', UNIT_NAME], { stdio: 'inherit' })
  try {
    execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'inherit' })
  } catch {
    log('could not enable linger — the daemon will stop when you log out')
  }
  log(`installed and started ${UNIT_NAME} (systemd user unit, enabled)`)
  log(`logs: journalctl --user -u r3-cache -n 20`)
}

export async function uninstallAutoStart(log: (message: string) => void): Promise<void> {
  if (process.platform === 'win32') {
    execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], { stdio: 'inherit' })
    log(`removed logon task "${TASK_NAME}"`)
    return
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', UNIT_NAME], { stdio: 'inherit' })
  } catch {
    // Not installed — removing the unit file below is still right.
  }
  await fsp.rm(path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME), { force: true })
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  log(`removed ${UNIT_NAME}`)
}
