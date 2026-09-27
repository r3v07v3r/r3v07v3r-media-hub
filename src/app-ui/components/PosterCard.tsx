import { Link } from 'react-router-dom'
import type { PosterItem } from '../lib/posterItem'
import './PosterCard.css'

/** One poster tile, everywhere a title is shown as an image + a name:
 *  browse grids, search results, and the Home rows. Always a real <a> (via
 *  Link) so it's a genuine focusable, navigable element rather than a
 *  clickable div. */
export default function PosterCard({ item }: { item: PosterItem }) {
  return (
    <Link to={`/title/${item.kind}/${item.id}`} className="poster-card">
      <span className="poster-card__art">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" decoding="async" /> : null}
      </span>
      <span className="poster-card__title">{item.title}</span>
      {item.subtitle ? <span className="poster-card__subtitle">{item.subtitle}</span> : null}
    </Link>
  )
}
