'use client'

// Updates — the app's own version, its channel, and what it is doing about
// getting the next one.
//
// It has its own rail entry rather than sitting as a tile inside General,
// which is where it used to live. "Which build am I on and why has it not
// updated" is a question people go LOOKING for an answer to; buried third
// down a settings category it was found by accident or not at all.
//
// The cache server's updates are NOT duplicated here. It updates itself on
// its own schedule and its whole updater state — channel, last check, staged
// version, why it has not applied yet — is reported in Caching, beside the
// server it belongs to. Two places for that state would be two places for it
// to disagree, so this section names where it lives instead of copying it.

import { Icon } from '@renderer/components/icons/Icon'
import {
  updateStatusLine,
  updateTone,
  useUpdateManager,
  type UpdateTone
} from '@renderer/hooks/useUpdateManager'
import styles from './CachingSection.module.css'
import own from './UpdatesSection.module.css'

const LAMP_CLASS: Record<UpdateTone, string> = {
  ok: own.lampOk,
  error: own.lampError,
  busy: own.lampBusy,
  idle: ''
}

/** What each channel actually signs you up for, in the terms that matter:
 *  how often, and how finished. */
const CHANNEL_BLURB = {
  stable: 'Released builds only. Fewer updates, each one shaken out on preview first.',
  preview: 'Every build as it is cut. New things sooner, and the rough edges that come with them.'
} as const

export function UpdatesSection() {
  const update = useUpdateManager()
  const state = update.status?.state
  const tone = updateTone(state)
  const downloading = state === 'downloading' || state === 'available'
  const percent = update.status?.percent

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h2 className={styles.title}>Updates</h2>
        <p className={styles.blurb}>
          Which build of R3 Media Hub is running, which ones it will accept next, and what the last
          one changed.
        </p>
      </header>

      {update.bridgeMissing ? (
        <section className={`${styles.card} glass-panel`}>
          <p className={styles.note}>
            Running outside the Electron shell, so there is no installed build to check. Updates are
            managed by the desktop app.
          </p>
        </section>
      ) : (
        <>
          <section className={`${styles.card} glass-panel`}>
            <div className={own.identity}>
              <div className={own.versionBlock}>
                <span className={own.versionEyebrow}>Running now</span>
                <span className={own.version}>{update.version ? `v${update.version}` : '—'}</span>
              </div>
              <span className={own.channelTag}>
                {update.channel === 'preview' ? 'Preview channel' : 'Stable channel'}
              </span>
            </div>

            {/* The lamp is never the only signal — the sentence beside it says
                the same thing in words, so the state is readable without
                telling one colour from another. */}
            <p className={own.state}>
              <span className={`${own.lamp} ${LAMP_CLASS[tone]}`} aria-hidden="true" />
              {update.status
                ? updateStatusLine(update.status)
                : 'Not checked since this app started. Updates are also checked for on their own.'}
            </p>

            {downloading && percent !== undefined && (
              <div
                className={own.progressTrack}
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Update download"
              >
                <div className={own.progressFill} style={{ width: `${percent}%` }} />
              </div>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() => void update.check()}
                disabled={update.checking}
              >
                <Icon name="refresh" size={13} /> {update.checking ? 'Checking…' : 'Check now'}
              </button>
              {state === 'ready' && (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => void update.install()}
                >
                  Restart &amp; install
                </button>
              )}
            </div>

            {/* Whichever note is the useful one: what the offered version
                changes while one is being offered, otherwise what the build
                actually running changed. Labelled, so they cannot be read as
                each other. */}
            {(update.offeredNotes || update.notes) && (
              <div className={own.notes}>
                <span className={own.notesLabel}>
                  {update.offeredNotes
                    ? `What's new in v${update.status?.version ?? 'the update'}`
                    : "What's new in this version"}
                </span>
                <p className={own.notesBody}>{update.offeredNotes || update.notes}</p>
              </div>
            )}
          </section>

          <section className={`${styles.card} glass-panel`}>
            <div className={styles.cardHead}>
              <div>
                <h3 className={styles.cardTitle}>Channel</h3>
                <p className={styles.note}>{CHANNEL_BLURB[update.channel]}</p>
              </div>
            </div>
            <div className={own.channels} role="radiogroup" aria-label="Update channel">
              {(['stable', 'preview'] as const).map((channel) => (
                <button
                  key={channel}
                  type="button"
                  role="radio"
                  aria-checked={update.channel === channel}
                  className={`${own.channel} ${update.channel === channel ? own.channelActive : ''}`}
                  onClick={() => void update.setChannel(channel)}
                >
                  <span className={own.channelName}>
                    {channel === 'stable' ? 'Stable' : 'Preview'}
                  </span>
                  <span className={own.channelBlurb}>{CHANNEL_BLURB[channel]}</span>
                </button>
              ))}
            </div>
          </section>

          <section className={`${styles.card} glass-panel`}>
            <h3 className={styles.cardTitle}>How this works</h3>
            <p className={styles.note}>
              An update on your channel is downloaded in the background as soon as it is found. It
              is never applied under you — it waits until you restart, either from the button above
              or the next time you open the app.
            </p>
            <p className={styles.note}>
              The cache server on your network updates itself, on its own schedule and never while
              anybody is streaming from it. Its version, what it has staged and why it is waiting
              are in <b>Caching</b>, beside the server they belong to.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
