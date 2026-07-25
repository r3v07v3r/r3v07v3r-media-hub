import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { NAV_ITEMS } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './SidebarNavigation.module.css'

// Mobile's fixed bottom nav has room for 5 primary destinations + a
// "More" trigger (spec section 8) — not all 9 NAV_ITEMS. Home/Movies/TV
// Shows/Live TV/Music are the everyday destinations; Sports, My Stuff,
// Downloads, and Settings move into the More sheet.
const MOBILE_PRIMARY_IDS = ['home', 'movies', 'tv', 'live', 'music']

export function SidebarNavigation() {
  const pathname = useLocation().pathname
  const [collapsed, setCollapsed] = useState(false)
  const [userOverride, setUserOverride] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  // Auto-collapse to an icon-only rail at the tablet breakpoint and below
  // (<1100px — spec section 16's "Compact desktop 1100-1439px / Tablet
  // 768-1099px" boundary), unless the person has explicitly toggled it —
  // a manual choice should stick until they change it again, not get
  // silently overridden by the next resize.
  useEffect(() => {
    function apply() {
      if (userOverride) return
      setCollapsed(window.innerWidth < 1100)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [userOverride])

  // Below 768px the rail becomes a fixed bottom nav with a trimmed item
  // set (see MOBILE_PRIMARY_IDS) — tracked separately from `collapsed`
  // since mobile isn't just a narrower icon rail, it's a different nav
  // shape entirely (spec section 8/9).
  useEffect(() => {
    function apply() {
      setIsMobile(window.innerWidth < 768)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  // Publishes the rail's real rendered width as a CSS variable other
  // components can read — MoodBrowser uses it to bleed its pill row
  // underneath this rail (per the reference), which only works if that
  // negative margin matches the rail's actual current width rather than
  // a guess. Zero on mobile: the rail moves to a bottom bar there, so
  // there's no left column left to bleed under. Lives on <html> (not a
  // local CSS module var) since the two components aren't siblings.
  useEffect(() => {
    const width = isMobile ? 0 : collapsed ? 84 : 220
    document.documentElement.style.setProperty('--nav-rail-width', `${width}px`)
  }, [collapsed, isMobile])

  // Closing the More sheet on route change keeps it from staying open
  // after the person taps through to a page — adjusted during render
  // (React's recommended "reset state on prop change" pattern) rather
  // than in an effect, so it doesn't cost an extra render pass.
  const [moreOpenForPathname, setMoreOpenForPathname] = useState(pathname)
  if (moreOpenForPathname !== pathname) {
    setMoreOpenForPathname(pathname)
    if (moreOpen) setMoreOpen(false)
  }

  const primaryItems = isMobile
    ? NAV_ITEMS.filter((item) => MOBILE_PRIMARY_IDS.includes(item.id))
    : NAV_ITEMS
  const overflowItems = isMobile
    ? NAV_ITEMS.filter((item) => !MOBILE_PRIMARY_IDS.includes(item.id))
    : []
  const overflowActive = overflowItems.some((item) =>
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-nav-item]') ?? []
    )
    const currentIndex = items.findIndex((el) => el === document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      items[(currentIndex + 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      items[(currentIndex - 1 + items.length) % items.length]?.focus()
    }
  }

  return (
    <nav
      className={`${styles.rail} ${collapsed ? styles.collapsed : ''}`}
      aria-label="Main navigation"
    >
      {/* Organic panel shape — reference target: a real SVG blob with a
          convex/concave right boundary (bulging out to ~230px around
          Home, drawing back in between items), not a clipped rectangle
          with a decorative line on top. viewBox 0-260 x / 0-1000 y with
          preserveAspectRatio="none" lets the same normalized wave map
          onto the rail's actual full-height pixel box. Three passes over
          the identical boundary curve: a filled region (the panel body
          itself — x=0/top/bottom are the screen's own straight edges,
          only the right side is organic) sitting behind everything, a
          dim static stroke tracing just that wavy boundary, and a bright
          short-dash stroke animating along it — "mostly a dim edge with
          isolated moving cyan energy highlights," not a uniform glowing
          border. */}
      <svg
        className={styles.railShape}
        viewBox="0 0 260 1000"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="railFillGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0a1220" stopOpacity="0.7" />
            <stop offset="65%" stopColor="#050a14" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#050a14" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          className={styles.railShapeFill}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000 Z"
          fill="url(#railFillGrad)"
        />
        <path
          className={styles.railShapeEdge}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className={styles.railShapeTravel}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* key={pathname} replays the breathe + one-shot burst keyframes on
          every route change — "the spine reacting when the active nav
          item changes" (motion spec section 4) without a full custom
          point-along-path animation. Positioned near the boundary's x at
          each node's approximate height rather than a fixed right:-3px,
          since the boundary is now a wave, not a straight edge. */}
      <span
        key={`node-a-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '19%', left: '172px', ['--node-delay' as string]: '0s' }}
        aria-hidden="true"
      />
      <span
        key={`node-b-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '59%', left: '178px', ['--node-delay' as string]: '0.6s' }}
        aria-hidden="true"
      />

      <button
        type="button"
        className={styles.toggle}
        onClick={() => {
          setUserOverride(true)
          setCollapsed((v) => !v)
        }}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
      >
        <Icon name={collapsed ? 'chevron' : 'chevron-left'} size={15} />
      </button>
      <ul className={styles.list} ref={listRef} onKeyDown={handleKeyDown}>
        {primaryItems.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                data-nav-item
                className={`${styles.item} ${active ? styles.itemActive : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.iconWrap}>
                  {active && <span className={styles.iconHalo} aria-hidden="true" />}
                  <Icon name={item.icon} />
                </span>
                <span className={styles.label}>
                  {item.label}
                  {active && <span className={styles.dot} aria-hidden="true" />}
                </span>
                {collapsed && !isMobile && (
                  <span className={styles.tooltip} role="tooltip">
                    {item.label}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
        {isMobile && (
          <li className={styles.moreWrap}>
            <button
              type="button"
              className={`${styles.item} ${styles.moreButton} ${overflowActive ? styles.itemActive : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-haspopup="true"
            >
              <span className={styles.iconWrap}>
                {overflowActive && <span className={styles.iconHalo} aria-hidden="true" />}
                <Icon name="more-horizontal" />
              </span>
              <span className={styles.label}>
                More
                {overflowActive && <span className={styles.dot} aria-hidden="true" />}
              </span>
            </button>
            {moreOpen && (
              <div className={`${styles.moreSheet} glass-panel`} role="menu">
                {overflowItems.map((item) => {
                  const active =
                    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
                  return (
                    <Link
                      key={item.id}
                      to={item.href}
                      role="menuitem"
                      className={`${styles.moreSheetItem} ${active ? styles.itemActive : ''}`}
                    >
                      <Icon name={item.icon} size={16} />
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            )}
          </li>
        )}
      </ul>
    </nav>
  )
}
