'use client'

// The cache server: joining one, seeing what it holds, and — if you own it
// — administering it.
//
// The surface has three states and shows exactly one of them, because they
// are three different questions:
//
//   NOT JOINED    "which server, and may I in?"
//   WAITING       "has the administrator said yes yet?"
//   JOINED        "what is it doing, and what am I using?"
//
// The admin block appears inside the joined state and only when the DAEMON
// says this device administers the server. Never on a local preference:
// isAdmin is decided by the daemon from what it has on disk, and a lock the
// backend does not enforce is theatre.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import type {
  LanCacheDevice,
  LanCacheOwnItem,
  LanCacheStatusResponse
} from '@shared/lancache/protocol'
import styles from './CachingSection.module.css'
import type { StreamCacheEntry, StreamCacheUsage } from '@shared/media-hub/types'

interface DiscoveredDaemon {
  name: string
  host: string
  port: number
  url: string
}

/** How often a device waiting for approval asks again. Deliberately slow:
 *  the answer arrives when a person on another machine gets round to it, so
 *  a tight poll would just be noise on someone else's server. */
const PAIR_POLL_MS = 4000
const STATUS_POLL_MS = 15_000

/** How long ago, in the coarsest unit that is still useful — the question
 *  this answers is "has it looked recently", not "exactly when". */
function ago(at: number | undefined): string {
  if (!at) return 'never'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/** SxxEyy, zero padded. "S2 · E7" and "S12 · E7" do not line up in a list;
 *  the padded form is the one people already read on release names. */
function episodeLabel(season?: number, episode?: number): string {
  if (episode === undefined) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  // Anime is frequently numbered straight through with no season at all,
  // so an episode on its own is a real key rather than a malformed one. It
  // gets E07 instead of an invented S00, which would be a claim about the
  // release that nobody made. A film has neither and gets no chip.
  if (season === undefined) return `E${pad(episode)}`
  return `S${pad(season)}E${pad(episode)}`
}

function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1024 ** 3) return `${Math.max(0, Math.round(value / 1024 ** 2))} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

export function CachingSection() {
  const api = window.api?.mediaHub?.lanCache

  const [pairState, setPairState] = useState<'none' | 'pending' | 'approved'>('none')
  const [status, setStatus] = useState<LanCacheStatusResponse | null>(null)
  const [statusError, setStatusError] = useState('')
  const [pairedUrl, setPairedUrl] = useState<string | null>(null)
  const [daemons, setDaemons] = useState<DiscoveredDaemon[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [url, setUrl] = useState('')
  const [shareTorbox, setShareTorbox] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const [devices, setDevices] = useState<LanCacheDevice[]>([])
  const [myItems, setMyItems] = useState<LanCacheOwnItem[]>([])
  const [openJoin, setOpenJoin] = useState(false)
  const [defaultPercent, setDefaultPercent] = useState(0)
  const [defaultQuotaBytes, setDefaultQuotaBytes] = useState<number | null>(null)
  /** THIS device's own cache, which is a different store from the server's
   *  and used to have a whole nav entry to itself. Kept here because both
   *  answer the same question — where is my media and how much room is
   *  left — and having them on separate pages meant checking two places to
   *  find out why a disk was full. */
  const [localItems, setLocalItems] = useState<StreamCacheEntry[]>([])
  const [localUsage, setLocalUsage] = useState<StreamCacheUsage | null>(null)
  /**
   * Separate from `busy` because this one is SLOW — the server checks its
   * release feed and stages a bundle before answering — and the button
   * needs to say so for as long as it runs rather than flicking back.
   */
  const [updating, setUpdating] = useState(false)

  /** Set while a request is in flight so the polls below cannot race a
   *  write and paint the pre-write answer over it. */
  const mutatingRef = useRef(false)
  /** Whether this device administers the server, which decides whether the
   *  poll below also refreshes the device list. Named once so the two
   *  effects that care cannot drift apart. */
  const isAdmin = status?.isAdmin === true

  const refreshStatus = useCallback(async () => {
    if (!api) return
    const result = await api.status()
    if (result.connected && result.status) {
      setStatus(result.status)
      setStatusError('')
    } else if (result.connected) {
      setStatus(null)
      setStatusError(result.error ?? 'The cache server did not answer.')
    } else {
      setStatus(null)
      setStatusError('')
    }
  }, [api])

  const refreshMyItems = useCallback(async () => {
    if (!api) return
    const result = await api.myItems()
    // An older daemon has no such route and answers ok:false. Empty list,
    // no error — the section already says the server predates this work.
    setMyItems(result.ok ? result.items : [])
  }, [api])

  const refreshLocal = useCallback(async () => {
    const media = window.api?.mediaHub
    if (!media) return
    const [entries, space] = await Promise.all([
      media.streamCache.list().catch(() => [] as StreamCacheEntry[]),
      media.streamCache.usage().catch(() => null)
    ])
    setLocalItems(entries ?? [])
    setLocalUsage(space)
  }, [])

  // Independent of the cache server entirely: this device has a cache
  // whether or not it has ever joined one, so this does not sit behind the
  // pairing state the rest of this page does.
  useEffect(() => {
    void Promise.resolve().then(refreshLocal)
    const timer = window.setInterval(() => void refreshLocal(), STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshLocal])

  const handleDeleteLocal = (token: string): void => {
    setLocalItems((prev) => prev.filter((entry) => entry.token !== token))
    window.api?.mediaHub?.streamCache.delete(token).catch(() => {
      // Best-effort, and the poll above re-syncs from disk either way.
    })
  }

  const refreshDevices = useCallback(async () => {
    if (!api) return
    const result = await api.devices()
    if (!result.ok) {
      setDevices([])
      return
    }
    setDevices(result.devices)
    setOpenJoin(result.openJoin)
    setDefaultPercent(result.defaultQuotaPercent)
    setDefaultQuotaBytes(result.defaultQuotaBytes)
  }, [api])

  // Initial load. Everything resolves through a microtask so no setState
  // lands synchronously in the effect body.
  useEffect(() => {
    if (!api) return
    void Promise.resolve().then(async () => {
      const [found, pair] = await Promise.all([api.discover(), api.pairStatus()])
      setDaemons(found.daemons)
      setPairedUrl(found.paired)
      setPairState(pair.state)
      if (pair.state === 'approved') {
        await refreshStatus()
        await refreshMyItems()
      }
    })
  }, [api, refreshStatus, refreshMyItems])

  // Waiting for approval: ask, slowly, until the answer changes. The main
  // process is what flips the stored connection to approved, so this only
  // has to observe it.
  useEffect(() => {
    if (!api || pairState !== 'pending') return
    const timer = window.setInterval(() => {
      void (async () => {
        const pair = await api.pairStatus()
        setPairState(pair.state)
        if (pair.state === 'approved') {
          setMessage({ ok: true, text: 'Approved. This device may use the cache server.' })
          await Promise.all([refreshStatus(), refreshMyItems()])
        }
      })()
    }, PAIR_POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, pairState, refreshStatus, refreshMyItems])

  // Joined: keep the figures live, and the device list with them when this
  // device administers the server.
  //
  // The owned-item list polls WITH the status, not just on the actions that
  // change it. A fetch queued here finishes on the server minutes later, and
  // without this the finished title never appears under what you have
  // cached — so it cannot be shared or removed until the app is restarted,
  // which is the point at which somebody assumes the fetch failed.
  useEffect(() => {
    if (!api || pairState !== 'approved') return
    const timer = window.setInterval(() => {
      if (mutatingRef.current) return
      // The device list polls WITH the figures when this device
      // administers the server. It used to load only when isAdmin
      // CHANGED, which after the first load it never does — and these
      // panels stay mounted across navigation, so a join request arriving
      // afterwards sat unseen until the app was restarted or some
      // unrelated admin action happened to refresh the list. Approving a
      // device is the one thing on this page somebody else is waiting on.
      void Promise.all([
        refreshStatus(),
        refreshMyItems(),
        isAdmin ? refreshDevices() : Promise.resolve()
      ])
    }, STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, pairState, isAdmin, refreshStatus, refreshMyItems, refreshDevices])

  useEffect(() => {
    if (!api || !isAdmin) return
    void Promise.resolve().then(refreshDevices)
  }, [api, isAdmin, refreshDevices])

  const header = (
    <header className={styles.head}>
      <h2 className={styles.title}>Caching</h2>
      <p className={styles.blurb}>
        A machine on your own network that fetches what you plan to watch ahead of time, so playback
        starts one LAN hop away instead of over a slow link. Everything it stores expires on its
        own.
      </p>
    </header>
  )

  // No bridge: the browser preview, or a window whose preload did not run.
  // Says so rather than rendering nothing — a blank panel behind a nav entry
  // reads as a broken section, and this is the one case where the section is
  // fine and the surroundings are not.
  if (!api) {
    return (
      <div className={styles.wrap}>
        {header}
        <section className={`${styles.card} glass-panel`}>
          <p className={styles.note}>Cache servers are managed from the desktop app.</p>
        </section>
      </div>
    )
  }

  const guard = async (work: () => Promise<void>): Promise<void> => {
    mutatingRef.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
      mutatingRef.current = false
    }
  }

  const handleDiscover = (): void =>
    void guard(async () => {
      setDiscovering(true)
      const found = await api.discover()
      setDaemons(found.daemons)
      setPairedUrl(found.paired)
      setDiscovering(false)
      if (!found.daemons.length) {
        setMessage({
          ok: false,
          text: 'No cache server answered. It may be off, or this network may block discovery — enter its address instead.'
        })
      }
    })

  const handleJoin = (targetUrl: string): void =>
    void guard(async () => {
      setMessage(null)
      const result = await api.pair({ url: targetUrl, shareTorboxToken: shareTorbox })
      setMessage({ ok: result.ok, text: result.message })
      if (!result.ok) return
      setPairState(result.pending ? 'pending' : 'approved')
      const found = await api.discover()
      setPairedUrl(found.paired)
      if (!result.pending) await refreshStatus()
    })

  const handleLeave = (): void =>
    void guard(async () => {
      await api.unpair()
      setPairState('none')
      setPairedUrl(null)
      setStatus(null)
      setDevices([])
      setMessage({ ok: true, text: 'Left. The server keeps its files until they expire.' })
    })

  const handleClaim = (): void =>
    void guard(async () => {
      const result = await api.claim()
      setMessage({ ok: result.ok, text: result.message })
      await refreshStatus()
      await refreshDevices()
    })

  const handleDevice = (
    id: string,
    action: 'approve' | 'deny' | 'revoke' | 'quota',
    quotaBytes?: number | null
  ): void =>
    void guard(async () => {
      const result = await api.deviceAction({ id, action, quotaBytes })
      if (!result.ok) setMessage({ ok: false, text: result.message ?? 'That did not work.' })
      await refreshDevices()
      await refreshStatus()
    })

  const handleCancelJob = (contentKey: string): void =>
    void guard(async () => {
      const result = await api.cancelJob({ contentKey })
      if (!result.ok) setMessage({ ok: false, text: result.message ?? 'That did not work.' })
      await refreshStatus()
    })

  const handleRemoveItem = (infoHash: string): void =>
    void guard(async () => {
      const result = await api.removeItem({ infoHash })
      if (!result.ok) setMessage({ ok: false, text: result.message ?? 'That did not work.' })
      await refreshMyItems()
      await refreshStatus()
    })

  const handleSharing = (infoHash: string, visibility: 'private' | 'shared'): void =>
    void guard(async () => {
      const result = await api.setSharing({ infoHash, visibility })
      if (!result.ok) setMessage({ ok: false, text: result.message ?? 'That did not work.' })
      await refreshMyItems()
    })

  const handleUpdateNow = (): void => {
    if (!api) return
    setUpdating(true)
    void (async () => {
      try {
        const result = await api.updateNow()
        if (!result.ok) {
          setMessage({ ok: false, text: result.message ?? 'That did not work.' })
          return
        }
        // The daemon's own words. It knows whether it is restarting, waiting
        // on a stream, or already current, and paraphrasing that here would
        // be a second place for the four outcomes to drift apart.
        setMessage({ ok: result.outcome !== 'disabled', text: result.message })
        // Not after a restart: the server is going down, so asking it
        // anything now just times out. The 15-second poll picks it up again
        // when it comes back, which is the honest way to learn it is back.
        if (result.outcome !== 'restarting') await refreshStatus()
      } finally {
        setUpdating(false)
      }
    })()
  }

  const handleAdminSetting = (patch: { openJoin?: boolean; defaultQuotaPercent?: number }): void =>
    void guard(async () => {
      const result = await api.adminSettings(patch)
      if (!result.ok) setMessage({ ok: false, text: result.message ?? 'That did not work.' })
      await refreshDevices()
    })

  const pending = devices.filter((device) => device.status === 'pending')
  const approved = devices.filter((device) => device.status === 'approved')
  const usedShare = status && status.budgetBytes > 0 ? status.usedBytes / status.budgetBytes : 0
  const myShare =
    status && status.quotaBytes && status.usedByMeBytes !== undefined
      ? Math.min(1, status.usedByMeBytes / status.quotaBytes)
      : 0
  /** A server built before per-device figures and administration existed.
   *  Detected by the fields being ABSENT rather than by a version string —
   *  what the app can offer depends on what this server actually answers,
   *  not on what its number implies. */
  const olderServer = Boolean(status) && status?.unclaimed === undefined

  return (
    <div className={styles.wrap}>
      {header}

      {/* ---------- THIS DEVICE ----------

          What playing a title left on this machine. It had its own nav
          entry — Downloads — which put half the answer to "where is my
          media" on a different page from the other half. Storage is one
          subject, so it is one page. */}
      <section className={`${styles.card} glass-panel`}>
        <h3 className={styles.cardTitle}>On this device</h3>
        <p className={styles.note}>
          Titles you play are kept here so you can rewind, resume and watch them again without a
          connection.
          {localUsage
            ? ` ${bytes(localUsage.usedBytes)} used${
                localUsage.freeBytes !== null
                  ? `, ${bytes(localUsage.freeBytes)} free on that drive`
                  : ''
              }.`
            : ''}
        </p>
        {localItems.length === 0 ? (
          <p className={styles.note}>Nothing saved on this device yet.</p>
        ) : (
          <ul className={styles.itemList}>
            {localItems.map((entry) => (
              <li key={entry.token} className={styles.itemRow}>
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>
                    {entry.title}
                    {entry.isActive && <span className={styles.tag}>playing now</span>}
                  </span>
                  <span className={styles.itemMeta}>
                    {entry.seasonNumber !== undefined && entry.episodeNumber !== undefined
                      ? `${episodeLabel(entry.seasonNumber, entry.episodeNumber)} · `
                      : ''}
                    {bytes(entry.cachedBytes)}
                    {entry.totalBytes ? ` of ${bytes(entry.totalBytes)}` : ''}
                  </span>
                </span>
                {/* Not offered for whatever is playing: the daemon's own
                    remove route refuses the same case, and deleting the
                    file under the player is the one delete nobody means. */}
                {!entry.isActive && (
                  <button
                    type="button"
                    className={styles.ghostButton}
                    onClick={() => handleDeleteLocal(entry.token)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- WAITING ---------- */}
      {pairState === 'pending' && (
        <section className={`${styles.card} ${styles.waiting} glass-panel`}>
          <span className={styles.waitingPulse} aria-hidden="true" />
          <div>
            <h3 className={styles.cardTitle}>Waiting to be let in</h3>
            <p className={styles.note}>
              This device has asked to join {pairedUrl ?? 'the cache server'}. Whoever administers
              that server approves it there — nothing else is needed here, and this will notice when
              it happens.
            </p>
          </div>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={handleLeave}
            disabled={busy}
          >
            Cancel
          </button>
        </section>
      )}

      {/* ---------- NOT JOINED ---------- */}
      {pairState === 'none' && (
        <section className={`${styles.card} glass-panel`}>
          <h3 className={styles.cardTitle}>Join a cache server</h3>
          {daemons.length > 0 && (
            <ul className={styles.serverList}>
              {daemons.map((daemon) => (
                <li key={daemon.url} className={styles.serverRow}>
                  <span className={styles.serverIcon} aria-hidden="true">
                    <Icon name="stack" size={17} />
                  </span>
                  <span className={styles.serverText}>
                    <span className={styles.serverName}>{daemon.name}</span>
                    <span className={styles.serverAddress}>{daemon.url}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => handleJoin(daemon.url)}
                    disabled={busy}
                  >
                    Ask to join
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Address, if it was not found</span>
            <input
              className={styles.fieldInput}
              type="text"
              placeholder="http://192.168.1.20:8945"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>

          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={shareTorbox}
              onChange={(event) => setShareTorbox(event.target.checked)}
            />
            <span>
              Let this server download with my TorBox account. The key is copied to that machine —
              protected by file permissions, not an OS keychain — so your titles can be fetched
              overnight with the app closed. Everyone who joins shares their own account, and every
              download bills whoever asked for that title. Leaving revokes yours.
            </span>
          </label>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={handleDiscover}
              disabled={discovering || busy}
            >
              {discovering ? 'Searching…' : 'Search the network'}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => handleJoin(url)}
              disabled={busy || !url.trim()}
            >
              {busy ? 'Asking…' : 'Ask to join'}
            </button>
          </div>
        </section>
      )}

      {/* ---------- JOINED ---------- */}
      {pairState === 'approved' && (
        <>
          {olderServer && (
            <section className={`${styles.card} ${styles.claim} glass-panel`}>
              <span className={styles.claimIcon} aria-hidden="true">
                <Icon name="info" size={18} />
              </span>
              <div>
                <h3 className={styles.cardTitle}>This server is running an older build</h3>
                <p className={styles.note}>
                  It answers without the per-device figures, so &ldquo;Yours&rdquo; and the other
                  devices&rsquo; queue are blank, and it has no notion of an administrator yet —
                  which is why there is nothing here to take. It updates itself; this appears once
                  it has.
                </p>
              </div>
            </section>
          )}
          {/* ADMIN FIRST, above the status card.

              Claiming and the device list were underneath it, and the
              status card is tall — meters, four figures, the queue and the
              updater — so "Administer it" sat below the fold and was found
              by accident. Status is reference and can wait; an unclaimed
              server and a device waiting for approval are things to ACT on,
              and they belong where they are seen. */}
          {status?.unclaimed && (
            <section className={`${styles.card} ${styles.claim} glass-panel`}>
              <span className={styles.claimIcon} aria-hidden="true">
                <Icon name="lock" size={18} />
              </span>
              <div>
                <h3 className={styles.cardTitle}>Nobody administers this server</h3>
                <p className={styles.note}>
                  Take it and you decide who else may join, and how much of the disk each device
                  gets. Only one device holds this, and only the server&apos;s own console can hand
                  it over afterwards.
                </p>
              </div>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={handleClaim}
                disabled={busy}
              >
                Administer it
              </button>
            </section>
          )}
          {status?.isAdmin && (
            <section className={`${styles.card} glass-panel`}>
              <div className={styles.cardHead}>
                <div>
                  <h3 className={styles.cardTitle}>Devices</h3>
                  <p className={styles.note}>
                    You administer this server. Devices ask to join and wait here until you say yes.
                  </p>
                </div>
              </div>

              {pending.length > 0 && (
                <ul className={styles.deviceList}>
                  {pending.map((device) => (
                    <li key={device.id} className={`${styles.deviceRow} ${styles.devicePending}`}>
                      <span className={styles.deviceText}>
                        <span className={styles.deviceName}>{device.deviceName}</span>
                        <span className={styles.deviceMeta}>Asking to join</span>
                      </span>
                      <button
                        type="button"
                        className={styles.ghostButton}
                        onClick={() => handleDevice(device.id, 'deny')}
                        disabled={busy}
                      >
                        Deny
                      </button>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={() => handleDevice(device.id, 'approve')}
                        disabled={busy}
                      >
                        Approve
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <ul className={styles.deviceList}>
                {approved.map((device) => (
                  <li key={device.id} className={styles.deviceRow}>
                    <span className={styles.deviceText}>
                      <span className={styles.deviceName}>
                        {device.deviceName}
                        {device.isAdmin && <span className={styles.tag}>administrator</span>}
                        {device.isYou && <span className={styles.tag}>this device</span>}
                      </span>
                      <span className={styles.deviceMeta}>
                        {device.quotaBytes === null
                          ? defaultQuotaBytes === null
                            ? 'No allocation — bounded by the whole disk'
                            : `${bytes(defaultQuotaBytes)} (the default)`
                          : bytes(device.quotaBytes)}
                      </span>
                    </span>
                    {/* The per-device allocation, editable. The daemon has
                        accepted this since quotas landed and there was no
                        way to send it — the default slider set everyone the
                        same share, which is not what per-device means.

                        Blank clears it back to the default rather than
                        meaning zero: an allocation of nothing would be a way
                        to lock somebody out by the back door, and the daemon
                        already treats null as "use the default". */}
                    <label className={styles.deviceQuota}>
                      <span className={styles.deviceQuotaLabel}>GB</span>
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min={1}
                        step={1}
                        placeholder="default"
                        aria-label={`Allocation for ${device.deviceName} in GB`}
                        defaultValue={
                          device.quotaBytes === null
                            ? ''
                            : String(Math.round(device.quotaBytes / 1024 ** 3))
                        }
                        disabled={busy}
                        onBlur={(event) => {
                          // ZERO IS BLANK, not an allocation of nothing.
                          // This field's own help text calls an empty value
                          // the default and warns that zero would be an
                          // accidental lockout, but zero was being sent as a
                          // real quota -- and the next hourly pass evicts
                          // every item belonging to a device that is over
                          // its allocation, which for an allocation of zero
                          // is all of them. Clearing a box should not wipe a
                          // member's cache.
                          const raw = event.target.value.trim()
                          const parsed = raw === '' ? null : Math.round(Number(raw))
                          if (parsed !== null && !Number.isFinite(parsed)) return
                          const gb = parsed === null || parsed <= 0 ? null : parsed
                          handleDevice(device.id, 'quota', gb === null ? null : gb * 1024 ** 3)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                        }}
                      />
                    </label>
                    {/* Revoking your own device would lock you out of a
                        server only its console can reopen. The daemon
                        refuses it outright; the button is not offered
                        either, so the refusal is never a surprise. */}
                    {!device.isYou && (
                      <button
                        type="button"
                        className={styles.ghostButton}
                        onClick={() => handleDevice(device.id, 'revoke')}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              <div className={styles.toggleRow}>
                <span className={styles.toggleText}>
                  <span className={styles.toggleTitle}>
                    Anyone on this network may join without asking
                  </span>
                  <span className={styles.note}>
                    Convenient on a network only your household reaches. Off, every new device waits
                    for you.
                  </span>
                </span>
                {/* A switch rather than a checkbox: it is the same
                    on/off decision the redesigned settings render this
                    way, and one raw checkbox among pill buttons and
                    sliders reads as something nobody styled. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={openJoin}
                  aria-label="Anyone on this network may join without asking"
                  className={`${styles.switch} ${openJoin ? styles.switchOn : ''}`}
                  onClick={() => handleAdminSetting({ openJoin: !openJoin })}
                  disabled={busy}
                >
                  <span className={styles.switchThumb} />
                </button>
              </div>

              <label className={styles.sliderRow}>
                <span className={styles.sliderHead}>
                  <span className={styles.toggleTitle}>Default allocation per device</span>
                  <span className={styles.sliderValue}>
                    {defaultPercent === 0
                      ? 'None — the whole disk is the only limit'
                      : `${defaultPercent}% · ${bytes(defaultQuotaBytes)}`}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={defaultPercent}
                  onChange={(event) => setDefaultPercent(Number(event.target.value))}
                  // Committed on release rather than on every frame: the
                  // drag would otherwise write to the server sixty times a
                  // second for one decision.
                  onPointerUp={() => handleAdminSetting({ defaultQuotaPercent: defaultPercent })}
                  onKeyUp={() => handleAdminSetting({ defaultQuotaPercent: defaultPercent })}
                  disabled={busy}
                />
              </label>
            </section>
          )}
          <section className={`${styles.card} glass-panel`}>
            <div className={styles.cardHead}>
              <div>
                <h3 className={styles.cardTitle}>{status?.serverName ?? 'Cache server'}</h3>
                <p className={styles.note}>
                  {statusError
                    ? `${pairedUrl} — unreachable right now (${statusError})`
                    : pairedUrl}
                </p>
              </div>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={handleLeave}
                disabled={busy}
              >
                Leave
              </button>
            </div>

            {status && (
              <>
                <div className={styles.meters}>
                  <div className={styles.meter}>
                    <span className={styles.meterLabel}>The whole server</span>
                    <span className={styles.meterTrack}>
                      <span
                        className={styles.meterFill}
                        style={{ width: `${Math.min(100, usedShare * 100)}%` }}
                      />
                    </span>
                    <span className={styles.meterValue}>
                      {bytes(status.usedBytes)} of {bytes(status.budgetBytes)} · {status.itemCount}{' '}
                      title{status.itemCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className={styles.meter}>
                    <span className={styles.meterLabel}>Yours</span>
                    <span className={styles.meterTrack}>
                      <span
                        className={styles.meterFill}
                        style={{ width: `${Math.min(100, myShare * 100)}%` }}
                      />
                    </span>
                    <span className={styles.meterValue}>
                      {bytes(status.usedByMeBytes)}
                      {status.quotaBytes === null
                        ? ' · no allocation set'
                        : ` of ${bytes(status.quotaBytes)}`}
                    </span>
                  </div>
                </div>

                <dl className={styles.facts}>
                  <div>
                    <dt>Streaming now</dt>
                    <dd>{status.activeStreams}</dd>
                  </div>
                  <div>
                    {/* An administrator is shown the whole queue, so calling
                        it "yours" would be wrong; everyone else is looking at
                        a list that really is only their own. */}
                    <dt>{status.isAdmin ? 'Queue' : 'Your queue'}</dt>
                    <dd>{status.jobs.length}</dd>
                  </div>
                  {Boolean(status.othersJobCount) && (
                    <div>
                      <dt>Other devices&apos; queue</dt>
                      <dd>{status.othersJobCount}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Your TorBox account</dt>
                    <dd>{status.torboxLinked ? 'Linked' : 'Not linked'}</dd>
                  </div>
                </dl>

                {status.jobs.length > 0 && (
                  <ul className={styles.jobs}>
                    {status.jobs.map((job) => (
                      <li key={job.contentKey} className={styles.job}>
                        <span className={styles.jobTitle}>
                          <span className={styles.jobTitleText}>{job.title}</span>
                          {/* The title on a job is the SERIES title, so a
                              queue holding several episodes of one show was
                              several identical rows — the "duplicates".
                              They were always different episodes. */}
                          {job.episode !== undefined && (
                            <span className={styles.jobEpisode}>
                              {episodeLabel(job.season, job.episode)}
                            </span>
                          )}
                          {/* What this entry is doing on the server. The reason comes from
                                the wanted list, which already knew; the name is sent to the
                                administrator only, since anyone else is looking at a list of
                                their own jobs where it could only ever say "you". */}
                          {job.reason && (
                            <span className={styles.jobReason}>
                              {job.reason === 'watching' ? 'Watching' : 'Prefetch'}
                              {job.ownerName ? `: ${job.ownerName}` : ''}
                            </span>
                          )}
                        </span>
                        <span className={styles.jobState}>
                          {job.state}
                          {job.resolution ? ` · ${job.resolution}p` : ''}
                          {job.sizeBytes
                            ? ` · ${Math.round((job.progressBytes / job.sizeBytes) * 100)}%`
                            : ''}
                        </span>
                        {/* Only where there is something to cancel. A
                            finished fetch stays listed for an hour and a
                            stopped one for a day, and the daemon cannot
                            cancel either — the button did nothing on those
                            rows and reported that it had worked. */}
                        {(job.state === 'queued' || job.state === 'fetching') && (
                          <button
                            type="button"
                            className={styles.ghostButton}
                            disabled={busy}
                            onClick={() => handleCancelJob(job.contentKey)}
                          >
                            Cancel
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* The whole updater state, not just the staged line.

                    "Why has it not updated yet" has several correct answers —
                    it has not looked yet (it checks every four to six hours),
                    it looked and there was nothing newer, it staged one and is
                    waiting for a quiet hour, or it tried and failed — and one
                    line about a staged version could not tell them apart. All
                    four are in what the daemon already reports; it was simply
                    not being shown. */}
                {status.updater && (
                  <dl className={styles.facts}>
                    <div>
                      <dt>Update channel</dt>
                      <dd className={styles.factSmall}>{status.updater.channel || '—'}</dd>
                    </div>
                    <div>
                      <dt>Last checked</dt>
                      <dd className={styles.factSmall}>{ago(status.updater.checkedAt)}</dd>
                    </div>
                    <div>
                      <dt>Newest seen</dt>
                      <dd className={styles.factSmall}>{status.updater.latestSeen || '—'}</dd>
                    </div>
                    <div>
                      <dt>Staged</dt>
                      <dd className={styles.factSmall}>{status.updater.staged || 'nothing'}</dd>
                    </div>
                  </dl>
                )}

                {status.updater?.staged ? (
                  <p className={styles.note}>
                    {status.updater.staged} is ready. It applies once no one has streamed for half
                    an hour and the hour is a quiet one for this household — or after 24 hours
                    staged, whichever comes first.
                  </p>
                ) : (
                  <p className={styles.note}>
                    Nothing staged. The server looks for a new build every four to six hours, so a
                    release published since its last check has not been seen yet.
                  </p>
                )}

                {/* UPDATE NOW, for the administrator only.

                    The four-to-six hour poll is the right default and a poor
                    answer to "I have just cut a release and I want it on the
                    box". This checks the feed immediately and installs as soon
                    as it can.

                    It cannot cut somebody's film short: the daemon still
                    refuses to restart while a stream is open, and answers that
                    it will go in when the stream ends. Deciding the update
                    policy is the administrator's; ending someone else's
                    evening from a settings page is not. */}
                {isAdmin && (
                  <div className={styles.updateRow}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={busy || updating}
                      onClick={handleUpdateNow}
                    >
                      {updating ? 'Checking…' : 'Update now'}
                    </button>
                    <span className={styles.note}>
                      Checks for a new build straight away and installs it as soon as nobody is
                      watching.
                    </span>
                  </div>
                )}

                {status.updater?.lastError && (
                  <p className={`${styles.message} ${styles.messageError}`}>
                    Last update attempt failed: {status.updater.lastError}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Claiming is offered only while the server says nobody owns it.
              It is on the unauthenticated ping for exactly this reason: an
              app that has just found a daemon has to know whether to show
              this before it holds any credential. */}

          {/* YOUR OWN TITLES, and who else can reach them.

              The daemon has had the sharing route since entitlement landed
              and nothing could call it: there was no way to see your own
              items, because A1 deleted the listing that showed everybody
              everything. /api/items/mine is the narrow replacement — scoped
              to what this device paid for, which is the one listing
              entitlement allows.

              Not gated on being the administrator. These are your files;
              deciding who else may watch them is the owner's call, and the
              admin has no special claim on it. */}
          {myItems.length > 0 && (
            <section className={`${styles.card} glass-panel`}>
              <div className={styles.cardHead}>
                <div>
                  <h3 className={styles.cardTitle}>What you have cached</h3>
                  <p className={styles.note}>
                    Titles you fetched onto this server. Shared ones can be streamed by anyone else
                    who has joined it; private ones only by you.
                  </p>
                </div>
              </div>
              <ul className={styles.deviceList}>
                {myItems.map((item) => (
                  <li key={item.infoHash} className={styles.deviceRow}>
                    <span className={styles.deviceText}>
                      <span className={styles.deviceName}>{item.title}</span>
                      <span className={styles.deviceMeta}>
                        {bytes(item.sizeBytes)}
                        {item.complete ? '' : ' · still fetching'}
                        {item.visibility === 'shared'
                          ? ' · shared with everyone here'
                          : item.sharedWith > 0
                            ? ` · shared with ${item.sharedWith} device${item.sharedWith === 1 ? '' : 's'}`
                            : ' · only you'}
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={item.visibility === 'shared'}
                      aria-label={`Share ${item.title} with everyone on this server`}
                      className={`${styles.switch} ${item.visibility === 'shared' ? styles.switchOn : ''}`}
                      disabled={busy}
                      onClick={() =>
                        handleSharing(
                          item.infoHash,
                          item.visibility === 'shared' ? 'private' : 'shared'
                        )
                      }
                    >
                      <span className={styles.switchThumb} />
                    </button>
                    {/* Deleting a title you fetched. Reclaims the space now
                        rather than waiting for the idle TTL, and leaves no
                        tombstone — a deliberate delete is not the feeder
                        being told the household lost interest, so it may
                        come back if it is still on somebody's list. */}
                    <button
                      type="button"
                      className={styles.ghostButton}
                      disabled={busy}
                      onClick={() => handleRemoveItem(item.infoHash)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {message && (
        <p className={`${styles.message} ${message.ok ? styles.messageOk : styles.messageError}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
