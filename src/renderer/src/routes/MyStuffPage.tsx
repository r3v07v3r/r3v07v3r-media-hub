import { Link } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { CATALOG } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import { ComingSoonSection } from '@renderer/components/placeholder/ComingSoonSection'
import styles from './MyStuff.module.css'

export default function MyStuffPage() {
  const { myList, toggleMyList, openDetail } = useAppState()
  const items = CATALOG.filter((m) => myList.has(m.id))

  if (items.length === 0) {
    return (
      <ComingSoonSection
        icon="mystuff"
        title="My Stuff"
        description="Titles you save with “My List” will show up here. Nothing saved yet — try adding something from the Home dashboard."
      />
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>My Stuff</h1>
      <div className={styles.grid}>
        {items.map((m) => (
          <div key={m.id} className={styles.card}>
            <button
              type="button"
              className={styles.art}
              style={{ background: `linear-gradient(150deg, ${m.artTint[0]}, ${m.artTint[1]})` }}
              onClick={() => openDetail(m)}
            >
              <span>{m.initials}</span>
            </button>
            <div className={styles.info}>
              <span className={styles.title}>{m.title}</span>
              <button
                type="button"
                className={styles.remove}
                onClick={() => toggleMyList(m.id)}
                aria-label={`Remove ${m.title} from My List`}
              >
                <Icon name="x" size={12} />
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <Link to="/" className={styles.backLink}>
        ← Back to Home
      </Link>
    </div>
  )
}
