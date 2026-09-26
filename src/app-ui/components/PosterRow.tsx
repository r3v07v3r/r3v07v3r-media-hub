import type { PosterItem } from '../lib/posterItem'
import PosterCard from './PosterCard'
import './PosterRow.css'

/** A horizontally-scrolling shelf of posters under a heading — Home's
 *  Continue Watching row and its recommendation rails. Renders nothing at
 *  all for an empty row rather than an empty heading, per the task brief. */
export default function PosterRow({ title, items }: { title: string; items: PosterItem[] }) {
  if (!items.length) return null
  return (
    <section className="poster-row">
      <h2 className="poster-row__title">{title}</h2>
      <div className="poster-row__track">
        {items.map((item) => (
          <PosterCard key={`${item.kind}:${item.id}`} item={item} />
        ))}
      </div>
    </section>
  )
}
