import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { NAV_ITEMS } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './SidebarNavigation.module.css'

// Mobile's fixed bottom nav has room for 5 primary destinations + a
// "More" trigger (spec section 8) — not all 7 NAV_ITEMS. Home/Movies/
// Series/Anime are the everyday content-browsing destinations; My Stuff
// rounds out the primary row, and Downloads/Settings move into the More
// sheet.
const MOBILE_PRIMARY_IDS = ['home', 'movies', 'tv', 'anime', 'mystuff']

// The luminous contour, in the SVG's own 245x1000 space. Written once and
// reused by every layer that traces it (the static edge plus the three
// travelling highlights) — it previously existed as eight hand-copied
// duplicates of the same `d` string, which is exactly the kind of thing
// that drifts the moment one of them is edited.
//
// Shape, per the design brief: enters from the viewport edge at the top
// and curves outward, reaches its widest through the upper-middle, draws
// back in around the middle, swells slightly again lower down, then
// sweeps back toward the viewport edge at the bottom. Deliberately not
// symmetrical — it should read as organic rather than as a rounded
// rectangle.
//
// The curve must stay CLEAR of the label column. An earlier version let
// it cross the lower rows on the grounds that the reference image does
// exactly that at its "Downloads" row — but in the running app a thin
// bright line straight through a word just reads as the word being cut
// in half, so the wave's real excursions now happen above the first row
// and below the last, and alongside the rows it only bows gently. The
// items occupy roughly 13%-85% of the rail's height; between those the
// path is held right of x=226 (see the clearance check in the commit
// message for the measured margin at each row).
const RAIL_EDGE_PATH =
  'M0,0 C30,2 96,26 150,62 C196,92 226,108 232,132 ' +
  'C240,168 242,232 240,300 C238,368 228,430 226,500 ' +
  'C224,566 232,626 238,690 C242,748 240,802 236,850 ' +
  'C232,898 214,946 178,978 C142,1000 78,1000 0,1000'

// Decorative points riding the contour — not menu items. `left` is a
// percentage of the rail's width, which lands them on the curve at ANY
// rail width: preserveAspectRatio="none" decouples only the VERTICAL
// axis from the viewBox, so horizontally x_px is exactly
// (x_viewBox / 245) x railWidth and a percentage tracks it precisely.
// These were absolute px until they had to be re-tuned by hand on every
// width change, which is what kept stranding them off the curve.
// Durations are deliberately unequal so the three never pulse in unison.
const EDGE_NODES = [
  { top: '26%', left: '95.5%', delay: '0s', duration: '3.4s' },
  { top: '47%', left: '79.5%', delay: '1.1s', duration: '4.6s' },
  { top: '70%', left: '77.5%', delay: '2.2s', duration: '4s' }
]

const COLLAPSE_STORAGE_KEY = 'r3.nav.collapsed'

// localStorage throws (not returns null) in a few real contexts — a
// packaged Electron renderer with storage partitioning off, or the
// browser preview build running from a sandboxed null origin. A nav rail
// that can't remember a preference is a much smaller problem than a nav
// rail that crashes the app, so both sides are defensive.
function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw === null ? null : raw === 'true'
  } catch {
    return null
  }
}
function writeStoredCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(value))
  } catch {
    /* preference simply won't persist — not worth surfacing */
  }
}

export function SidebarNavigation() {
  const pathname = useLocation().pathname
  // The stored preference doubles as the "has the person ever chosen?"
  // flag: absent means the width-driven auto-collapse below still owns
  // the state, present means their choice wins until they change it.
  const [collapsed, setCollapsed] = useState(
    () => readStoredCollapsed() ?? (typeof window !== 'undefined' && window.innerWidth < 1200)
  )
  const [userOverride, setUserOverride] = useState(() => readStoredCollapsed() !== null)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  )
  const [moreOpen, setMoreOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // One matchMedia-driven effect for both breakpoints instead of two
  // separate resize listeners recomputing on every pixel of a window
  // drag: the queries only fire when a boundary is actually crossed.
  //   <1200px  — auto-collapse to an icon-only rail, unless the person
  //              has explicitly toggled it. (The brief puts the collapse
  //              here rather than at the old 1100px: between 1200 and
  //              1599 the expanded rail is already running at its
  //              narrower compact width, and below 1200 there isn't room
  //              for labels at a size worth reading.)
  //   <768px   — the rail stops being a rail at all and becomes a fixed
  //              bottom bar with a trimmed item set (MOBILE_PRIMARY_IDS),
  //              which is why this is tracked separately from `collapsed`
  //              rather than treated as "even narrower" (spec section 8/9).
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1199px)')
    const mobile = window.matchMedia('(max-width: 767px)')
    function sync() {
      setIsMobile(mobile.matches)
      if (!userOverride) setCollapsed(compact.matches)
    }
    sync()
    compact.addEventListener('change', sync)
    mobile.addEventListener('change', sync)
    return () => {
      compact.removeEventListener('change', sync)
      mobile.removeEventListener('change', sync)
    }
  }, [userOverride])

  // Ctrl/Cmd+B — the standard "toggle the sidebar" binding (VS Code,
  // Slack, Notion). The rail's own toggle button is small and lives in a
  // corner; this makes the collapse a first-class action for anyone who
  // reaches for the keyboard. Skipped while typing so it can't fire from
  // the topbar's search field.
  useEffect(() => {
    if (isMobile) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'b' && e.key !== 'B') return
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (el instanceof HTMLElement && el.isContentEditable) return
      e.preventDefault()
      setUserOverride(true)
      setCollapsed((v) => {
        writeStoredCollapsed(!v)
        return !v
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isMobile])

  // Publishes --nav-rail-width on <html> so components that aren't
  // siblings of this one can react to the rail (MoodBrowser bleeds its
  // pill row underneath it; AppShell's .main offsets by it). This was
  // once a hardcoded 285/90 kept in sync by hand with .rail /
  // .rail.collapsed — measuring instead means a CSS width change can't
  // silently desync the rest of the layout, and it tracks the width
  // *during* the collapse transition rather than snapping to the end
  // value. Zero on mobile: the rail is a bottom bar there, so there's no
  // left column to bleed under.
  const measure = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    const width = isMobile ? 0 : Math.round(nav.getBoundingClientRect().width)
    document.documentElement.style.setProperty('--nav-rail-width', `${width}px`)
  }, [isMobile])

  useLayoutEffect(() => {
    measure()
  }, [measure, collapsed])

  // Catches the collapse transition mid-flight and the vh-driven sizing
  // in the stylesheet responding to a window resize.
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(nav)
    return () => observer.disconnect()
  }, [measure])

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
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))
  const overflowActive = overflowItems.some((item) => isActive(item.href))

  // Roving tabindex: the whole rail is ONE tab stop, and arrows move
  // within it — the standard pattern for a navigation list, and the
  // difference between "Tab once to reach the content" and "Tab seven
  // times past every destination". The active item is the one that keeps
  // tabindex=0 (falling back to the first) so returning to the rail
  // lands where you already are.
  const focusableIndex = Math.max(
    0,
    primaryItems.findIndex((item) => isActive(item.href))
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-nav-item]') ?? []
    )
    if (items.length === 0) return
    const currentIndex = items.findIndex((el) => el === document.activeElement)
    let nextIndex: number | null = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1 + items.length) % items.length
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + items.length) % items.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = items.length - 1
    }
    if (nextIndex === null) return
    e.preventDefault()
    items[nextIndex]?.focus()
  }

  return (
    <nav
      ref={navRef}
      className={`${styles.rail} ${collapsed ? styles.collapsed : ''}`}
      aria-label="Main navigation"
    >
      {/* Only the luminous contour lives in the SVG now. The panel body
          itself is a CSS wash on .rail (see its background/mask) rather
          than a filled path, so the glass fades out instead of ending at
          a hard edge — see RAIL_EDGE_PATH's comment for why that matters. */}
      <svg
        className={styles.railShape}
        viewBox="0 0 245 1000"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          {/* The contour must not be uniformly bright, and it must taper
              out rather than stopping dead at the top and bottom of the
              rail — "the flowing curve of light round the menu tapering
              off smoothly." A gradient down the stroke does both: zero
              opacity at both ends, with the peaks placed at the top
              bend, the widest point and the lower swell. */}
          {/* Asymmetric on purpose. The top now fades in over a much
              longer run (0 -> 0.2 -> 0.8 across the first quarter rather
              than reaching 0.92 by 18%), so the line emerges from
              nothing instead of arriving already lit. The bottom holds
              its brightness far longer before going out (0.62 at 82%,
              still 0.24 at 96%) — the previous fade started early enough
              that the whole lower third read as dying away. */}
          <linearGradient id="railEdgeGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6ed2ff" stopOpacity="0" />
            <stop offset="9%" stopColor="#8fddff" stopOpacity="0.08" />
            <stop offset="17%" stopColor="#8fddff" stopOpacity="0.24" />
            <stop offset="26%" stopColor="#a6e6ff" stopOpacity="0.8" />
            <stop offset="36%" stopColor="#7fd4ff" stopOpacity="0.68" />
            <stop offset="48%" stopColor="#5fb8ff" stopOpacity="0.42" />
            <stop offset="60%" stopColor="#8ec8ff" stopOpacity="0.66" />
            <stop offset="72%" stopColor="#9d9cff" stopOpacity="0.62" />
            <stop offset="82%" stopColor="#6ed2ff" stopOpacity="0.62" />
            <stop offset="90%" stopColor="#6ed2ff" stopOpacity="0.44" />
            <stop offset="96%" stopColor="#6ed2ff" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#6ed2ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          className={styles.railShapeEdge}
          d={RAIL_EDGE_PATH}
          vectorEffect="non-scaling-stroke"
        />
        {/* Short bright segments travelling the contour — "isolated
            moving energy highlights," not a fully-lit outline. A short
            dash riding a slow dashoffset loop. */}
        <path
          className={styles.railShapeTravel}
          d={RAIL_EDGE_PATH}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* A second, dimmer, violet-tinted highlight at a different
            offset and speed so the two never merge into one continuous
            bright line. */}
        <path
          className={styles.railShapeTravel2}
          d={RAIL_EDGE_PATH}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* Third: an occasional brighter flare rather than a third
            always-visible dash — mostly transparent, with one brief
            bright pulse per loop. */}
        <path
          className={styles.railShapeTravel3}
          d={RAIL_EDGE_PATH}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* key={pathname} replays the one-shot burst keyframe on every
          route change — the contour reacting when the active destination
          changes (motion spec section 4). */}
      {EDGE_NODES.map((node, i) => (
        <span
          key={`node-${i}-${pathname}`}
          className={styles.railNode}
          style={{
            top: node.top,
            left: node.left,
            ['--node-delay' as string]: node.delay,
            ['--node-duration' as string]: node.duration
          }}
          aria-hidden="true"
        />
      ))}

      <button
        type="button"
        className={styles.toggle}
        onClick={() => {
          setUserOverride(true)
          setCollapsed((v) => {
            writeStoredCollapsed(!v)
            return !v
          })
        }}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-keyshortcuts="Control+B"
        title={`${collapsed ? 'Expand' : 'Collapse'} navigation (Ctrl+B)`}
        aria-expanded={!collapsed}
      >
        <Icon name={collapsed ? 'chevron' : 'chevron-left'} size={14} />
      </button>
      <ul className={styles.list} ref={listRef} onKeyDown={handleKeyDown}>
        {primaryItems.map((item, index) => {
          const active = isActive(item.href)
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                data-nav-item
                tabIndex={index === focusableIndex ? 0 : -1}
                className={`${styles.item} ${active ? styles.itemActive : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed && !isMobile ? item.label : undefined}
              >
                <span className={styles.iconWrap}>
                  {/* Thin-line glyphs, per the brief — the weight is tuned
                      to the ~20px rendered size, not to the badge. */}
                  <Icon name={item.icon} strokeWidth={1.7} />
                </span>
                <span className={styles.label}>{item.label}</span>
                {/* Its own element rather than a child of the label: the
                    brief puts this pin-point at the far right of the
                    selected row, visually connecting it to the luminous
                    contour, so its distance from the text has to be
                    controlled independently of the text's own layout. */}
                {active && <span className={styles.dot} aria-hidden="true" />}
                {collapsed && !isMobile && (
                  // aria-hidden + the aria-label above rather than
                  // role="tooltip": the label text is already the link's
                  // accessible name, so exposing this too made every
                  // collapsed item announce its name twice.
                  <span className={styles.tooltip} aria-hidden="true">
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
                <Icon name="more-horizontal" />
              </span>
              <span className={styles.label}>More</span>
              {overflowActive && <span className={styles.dot} aria-hidden="true" />}
            </button>
            {moreOpen && (
              <div className={`${styles.moreSheet} glass-panel`} role="menu">
                {overflowItems.map((item) => {
                  const active = isActive(item.href)
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
