// The sentence a control shows in place of itself when the service it needs
// is not set up, with the button that goes there.
//
//   <RequiresSetup services={['simkl', 'trakt']} what="Scrobbling" />
//     -> "Scrobbling requires Simkl or Trakt to be set up."  [Set up Simkl] [Set up Trakt]
//
// One component rather than a sentence per call site, so the rule reads the
// same everywhere and the button always lands on the right heading
// (lib/setupPlaces.ts). `compact` is for menus and rows, where a card would
// not fit: one line, one button.

import { useAppState } from '@renderer/context/AppStateContext'
import { SETUP_PLACES, nameServices, type SetupService } from '@renderer/lib/setupPlaces'
import styles from './RequiresSetup.module.css'

interface Props {
  /** Any one of these makes the control work. */
  services: readonly SetupService[]
  /** The thing that cannot work yet, as the sentence's subject; "This"
   *  when left out. */
  what?: string
  /** A further sentence, when the plain rule is not enough on its own. */
  detail?: string
  compact?: boolean
}

export function RequiresSetup({ services, what, detail, compact = false }: Props) {
  const { openControlCentre } = useAppState()
  if (services.length === 0) return null
  const sentence = `${what ?? 'This'} requires ${nameServices(services)} to be set up.`
  return (
    <div
      className={`${styles.wrap} ${compact ? styles.compact : 'glass-panel'}`}
      role="status"
      data-requires-setup={services.join(' ')}
    >
      <p className={styles.text}>
        {sentence}
        {detail ? ` ${detail}` : ''}
      </p>
      <div className={styles.actions}>
        {services.map((service) => {
          const place = SETUP_PLACES[service]
          return (
            <button
              key={service}
              type="button"
              className={styles.button}
              onClick={() => openControlCentre(place.section, place.anchor)}
            >
              Set up {place.name.replace(/^(a|an|the) /, '')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
