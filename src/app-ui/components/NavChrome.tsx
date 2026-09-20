import { NavLink } from 'react-router-dom'
import './NavChrome.css'

const ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/browse/movie', label: 'Movies' },
  { to: '/browse/series', label: 'Series' },
  { to: '/browse/anime', label: 'Anime' },
  { to: '/search', label: 'Search' },
  { to: '/settings', label: 'Settings' }
]

/**
 * The app's only piece of chrome. Same markup at every size — a bottom tab
 * bar on a phone-shaped viewport becomes a slim left rail on a TV-shaped
 * one purely via NavChrome.css's media query (see the task brief's
 * "CSS-only switch"), so there is exactly one nav to keep in sync with the
 * routes above.
 */
export default function NavChrome() {
  return (
    <nav className="nav-chrome" aria-label="Primary">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => 'nav-chrome__item' + (isActive ? ' is-active' : '')}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
