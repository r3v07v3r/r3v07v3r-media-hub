import { Icon } from '@renderer/components/icons/Icon'
import { updateStatusLine, updateTone, useUpdateManager } from '@renderer/hooks/useUpdateManager'
import styles from './Settings.module.css'

/**
 * The update card: what build is running, which channel it follows, and the
 * two things anybody ever wants to do about it — check now, and restart into
 * the one that has been downloaded.
 *
 * Presentation only. Every bit of behaviour lives in useUpdateManager, which
 * the control centre's Updates section shares — the two surfaces show the
 * same state and drive the same IPC, and neither can drift.
 *
 * Rendered on the viewer's settings page (the short one) because "is my app
 * up to date, and what changed" is a question people ask from wherever they
 * happen to be, not one worth crossing into the control centre for.
 */
export function AboutUpdateSection() {
  const update = useUpdateManager()

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-about">
      <header className={styles.quickCardHead}>
        <h2 id="settings-about" className={styles.sectionTitle}>
          About &amp; Updates
        </h2>
        <p className={styles.quickCardHint}>
          The build you are running, and where it takes the next one from.
        </p>
      </header>

      <div className={styles.versionRow}>
        <span className={styles.versionLabel}>R3 Media Hub</span>
        <span className={styles.versionNumber}>{update.version ? `v${update.version}` : '—'}</span>
      </div>

      {update.bridgeMissing ? (
        <p className={styles.statusMessage}>
          Running outside the Electron shell — updates can&apos;t be checked here.
        </p>
      ) : (
        <>
          <div className={styles.channelToggle} role="radiogroup" aria-label="Update channel">
            {(['stable', 'preview'] as const).map((channel) => (
              <button
                key={channel}
                type="button"
                role="radio"
                aria-checked={update.channel === channel}
                className={`${styles.channelButton} ${
                  update.channel === channel ? styles.channelButtonActive : ''
                }`}
                onClick={() => void update.setChannel(channel)}
              >
                {channel === 'stable' ? 'Stable' : 'Preview'}
              </button>
            ))}
          </div>

          <div className={styles.serviceActions} style={{ marginTop: 12 }}>
            <button
              type="button"
              className={`${styles.testButton} ${styles.checkButton}`}
              onClick={() => void update.check()}
              disabled={update.checking}
            >
              <Icon name="refresh" size={13} />
              {update.checking ? 'Checking…' : 'Check for Updates'}
            </button>
            {update.status?.state === 'ready' && (
              <button
                type="button"
                className={styles.saveButton}
                onClick={() => void update.install()}
              >
                Restart &amp; Install
              </button>
            )}
          </div>

          {update.status && (
            <p
              className={`${styles.statusMessage} ${STATUS_CLASS[updateTone(update.status.state)]}`}
              style={{ marginTop: 8 }}
            >
              {updateStatusLine(update.status)}
            </p>
          )}

          <UpdateNotes manager={update} />
        </>
      )}
    </section>
  )
}

const STATUS_CLASS: Record<string, string> = {
  ok: styles.statusOk,
  error: styles.statusError,
  busy: styles.statusIdle,
  idle: styles.statusIdle
}

/**
 * Two different notes, and only ever one of them. While an update is being
 * offered or is waiting to install, what matters is what the NEW version
 * changes — reading about it is the whole point of being told an update
 * exists. Otherwise the note describes the build actually running. Labelled
 * so the two can never be mistaken for each other.
 */
function UpdateNotes({ manager }: { manager: ReturnType<typeof useUpdateManager> }) {
  const shown = manager.offeredNotes || manager.notes
  if (!shown) return null
  return (
    <div className={styles.notes}>
      <span className={styles.notesLabel}>
        {manager.offeredNotes
          ? `What's new in v${manager.status?.version ?? 'the update'}`
          : "What's new in this version"}
      </span>
      <p className={styles.notesBody}>{shown}</p>
    </div>
  )
}
