import { useEffect, useState } from 'react'

/**
 * True once `loading` has been continuously true for longer than `ms` —
 * the trigger for the "still loading" reassurance line (see
 * components/LoadingNote.tsx and the task brief: a first-time catalogue
 * fetch can take up to a minute with nothing else telling the person it is
 * working). Resets the moment `loading` goes false, so an ordinary fast
 * fetch never shows it.
 */
export function useSlowLoad(loading: boolean, ms = 3000): boolean {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!loading) {
      // A fetch finishing (or never having been slow) genuinely does reset
      // this synchronously — see useAsync's identical reasoning for the
      // same disable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), ms)
    return () => clearTimeout(timer)
  }, [loading, ms])

  return slow
}
