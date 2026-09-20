import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSlowLoad } from '../lib/useSlowLoad'
import './LoadingNote.css'

/**
 * The "this is normal, not stuck" line a slow first-time fetch needs — see
 * the task brief: the owner opened Anime on his phone and stared at an
 * empty screen for a long time with nothing telling him it was working.
 *
 * Renders nothing until `loading` has run past useSlowLoad's threshold, so
 * an ordinary fast fetch never shows it. Once it does, it also asks the
 * backend's central work manager (`activity`, preload/api.ts) what it is
 * doing right now and shows that as a second line when there is one —
 * subscribed only while this note is actually visible, and always
 * unsubscribed when it stops being (loading finishes, or the screen
 * unmounts).
 */
export default function LoadingNote({
  loading,
  subject = 'a catalogue'
}: {
  loading: boolean
  subject?: string
}) {
  const slow = useSlowLoad(loading)
  const [activityLabel, setActivityLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!slow) {
      // The note hiding genuinely does clear this synchronously — see
      // useAsync's identical reasoning for the same disable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActivityLabel(null)
      return
    }
    const mediaHub = api()
    if (!mediaHub) return
    let cancelled = false
    mediaHub.activity
      .get()
      .then((snapshot) => {
        if (!cancelled) setActivityLabel(snapshot.running[0]?.label ?? null)
      })
      .catch(() => {})
    const unsubscribe = mediaHub.activity.onChanged((snapshot) => {
      setActivityLabel(snapshot.running[0]?.label ?? null)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [slow])

  if (!slow) return null
  return (
    <p className="loading-note">
      Still loading — the first time {subject} is opened it is fetched from its source, which can
      take up to a minute.
      {activityLabel && <span className="loading-note__activity">{activityLabel}</span>}
    </p>
  )
}
