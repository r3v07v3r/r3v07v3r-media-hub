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

// Seven undifferentiated rows read as one long undifferentiated list —
// nothing tells you that Home/Movies/Series/Anime are "where content
// lives" while My Stuff/Downloads are "your own things" and Settings is
// housekeeping. Grouping is by first-id-of-a-group rather than a nested
// data structure so NAV_ITEMS stays a flat list (it's also consumed as
// one by the mobile filter above and by anything else importing it) —
// adding a nav item only needs an entry there, and only needs touching
// this constant if it should start a NEW group.
const GROUP_STARTS = new Set(['mystuff', 'settings'])

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
    () => readStoredCollapsed() ?? (typeof window !== 'undefined' && window.innerWidth < 1100)
  )
  const [userOverride, setUserOverride] = useState(() => readStoredCollapsed() !== null)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  )
  const [moreOpen, setMoreOpen] = useState(false)
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // One matchMedia-driven effect for both breakpoints instead of two
  // separate resize listeners recomputing on every pixel of a window
  // drag: the queries only fire when a boundary is actually crossed.
  //   <1100px  — auto-collapse to an icon rail (spec section 16's
  //              "Compact desktop 1100-1439 / Tablet 768-1099" boundary),
  //              unless the person has explicitly toggled it.
  //   <768px   — the rail stops being a rail at all and becomes a fixed
  //              bottom bar with a trimmed item set (MOBILE_PRIMARY_IDS),
  //              which is why this is tracked separately from `collapsed`
  //              rather than treated as "even narrower" (spec section 8/9).
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1099px)')
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

  // Two jobs, both driven by the rail's REAL measured geometry rather
  // than numbers duplicated from the stylesheet:
  //
  //  1. --nav-rail-width, published on <html> so components that aren't
  //     siblings of this one can react to the rail (MoodBrowser bleeds
  //     its pill row underneath it; AppShell's .main offsets by it).
  //     Previously this was a hardcoded 285/90 kept in sync by hand with
  //     .rail / .rail.collapsed — measuring instead means a CSS width
  //     change can't silently desync the rest of the layout, and it also
  //     tracks the width *during* the collapse transition rather than
  //     snapping to the end value. Zero on mobile: the rail is a bottom
  //     bar there, so there's no left column to bleed under.
  //  2. The active indicator's position — a single element that slides
  //     between items, so switching pages reads as one continuous
  //     movement instead of a glow blinking out here and in there.
  //     offsetTop is relative to .rail (the nearest positioned ancestor).
  const measure = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    const width = isMobile ? 0 : Math.round(nav.getBoundingClientRect().width)
    document.documentElement.style.setProperty('--nav-rail-width', `${width}px`)

    const activeLink = nav.querySelector<HTMLElement>('a[data-nav-item][aria-current="page"]')
    const row = activeLink?.closest('li')
    if (!row || isMobile) {
      setIndicator((prev) => (prev === null ? prev : null))
      return
    }
    // Half the row's height, vertically centred — a marker shorter than
    // the row itself reads as pointing at it, where a full-height bar
    // reads as a border.
    const next = { top: row.offsetTop + row.offsetHeight * 0.25, height: row.offsetHeight * 0.5 }
    setIndicator((prev) =>
      prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.height - next.height) < 0.5
        ? prev
        : next
    )
  }, [isMobile])

  useLayoutEffect(() => {
    measure()
  }, [measure, pathname, collapsed])

  // Covers everything a layout effect on [pathname, collapsed] can't see:
  // the width transition mid-flight, font loading reflowing labels, and
  // the vh-driven sizing in the stylesheet responding to a window resize.
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
      {/* Organic panel shape — reference target: a real SVG blob with a
          convex/concave right boundary (bulging out to ~230px around
          Home, drawing back in between items), not a clipped rectangle
          with a decorative line on top. viewBox 0-245 x / 0-1000 y with
          preserveAspectRatio="none" lets the same normalized wave map
          onto the rail's actual full-height pixel box — narrowed from the
          original 260 (a ~6% proportional zoom, not a path edit) so every
          point along the curve sits further right in real pixels, giving
          the item column more breathing room where the wave dips inward
          without reshaping it. Three passes over the identical boundary
          curve: a filled region (the panel body itself — x=0/top/bottom
          are the screen's own straight edges, only the right side is
          organic) sitting behind everything, a dim static stroke tracing
          just that wavy boundary, and a bright short-dash stroke
          animating along it — "mostly a dim edge with isolated moving
          cyan energy highlights," not a uniform glowing border. */}
      <svg
        className={styles.railShape}
        viewBox="0 0 245 1000"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="railFillGrad" x1="0" y1="0" x2="1" y2="0">
            {/* Third refinement pass: "more visible internal darkness" —
                both stops deepened (0.7 -> 0.8, 0.42 -> 0.52) so the
                shell's body reads as genuinely dense glass/hardware
                rather than a light tint, especially now that it's
                physically bigger and has more area to read as flat if
                left too translucent. 10-foot-interface pass: nudged once
                more (0.8 -> 0.86, 0.52 -> 0.58) — "strengthen glass shell
                visibility." */}
            <stop offset="0%" stopColor="#0a1220" stopOpacity="0.86" />
            <stop offset="65%" stopColor="#050a14" stopOpacity="0.58" />
            <stop offset="100%" stopColor="#050a14" stopOpacity="0" />
          </linearGradient>
          {/* Third pass: faint pooled glow near the item column — see
              .railShapeInnerGlow (SidebarNavigation.module.css) for the
              breathing animation. Off-center toward the icons (not a
              plain centered radial) so it reads as light the controls
              themselves are casting, not a generic panel backlight. */}
          <radialGradient id="railInnerGlowGrad" cx="26%" cy="52%" r="60%">
            <stop offset="0%" stopColor="#5ec8ff" stopOpacity="0.22" />
            <stop offset="55%" stopColor="#5ec8ff" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#5ec8ff" stopOpacity="0" />
          </radialGradient>
          {/* Premium HUD finish, not a flat web-sidebar panel: a soft
              diagonal sheen near the top-left (glass "internal
              reflection") and a matching dark pool along the bottom-right
              (an "inner shadow" read, since a literal inset box-shadow
              can't follow this organic boundary). Both painted with the
              same closed blob path as railShapeFill, just with a
              different gradient on top. */}
          {/* Third pass: nudged toward a more distinctly blue tint
              (#dff2ff -> #bfe6ff) and a touch brighter — "subtle blue
              reflection" called out explicitly this pass, vs. the
              previous near-white sheen.
              10-foot-interface pass: "strengthen inner reflection" — the
              sheen was reading as a faint hint at TV distance. Brightened
              the peak stop and pushed the falloff further down the shell
              (22%/55% -> 30%/62%) so the reflection reads as a real glass
              highlight band rather than a thin edge glow. */}
          <linearGradient id="railGlassSheen" x1="0" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#bfe6ff" stopOpacity="0.32" />
            <stop offset="30%" stopColor="#bfe6ff" stopOpacity="0.1" />
            <stop offset="62%" stopColor="#bfe6ff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="railInnerShadow" x1="0" y1="1" x2="0.4" y2="0.3">
            <stop offset="0%" stopColor="#000000" stopOpacity="0.38" />
            <stop offset="45%" stopColor="#000000" stopOpacity="0.12" />
            <stop offset="80%" stopColor="#000000" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          className={styles.railShapeFill}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000 Z"
          fill="url(#railFillGrad)"
        />
        <path
          className={styles.railShapeShadow}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000 Z"
          fill="url(#railInnerShadow)"
        />
        <path
          className={styles.railShapeSheen}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000 Z"
          fill="url(#railGlassSheen)"
        />
        <path
          className={styles.railShapeInnerGlow}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000 Z"
          fill="url(#railInnerGlowGrad)"
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
        {/* A second, dimmer, violet-tinted highlight travelling the same
            boundary at a different offset/speed — "occasional travelling
            energy highlights" (plural), not just one lone cyan dash. */}
        <path
          className={styles.railShapeTravel2}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 192,254 175,288 C160,318 165,358 178,394 C190,430 196,460 180,495 C168,524 165,556 178,590 C190,620 196,650 180,686 C168,716 165,746 175,776 C185,810 197,850 186,894 C176,930 140,960 90,980 C50,995 20,1000 0,1000"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* Third highlight — a slower, occasional brighter flare rather
            than a third always-visible dash (see .railShapeTravel3's
            keyframe: mostly transparent, one brief bright pulse per
            loop). "Add occasional brighter travelling highlights." */}
        <path
          className={styles.railShapeTravel3}
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
      {/* left values are absolute px matching the boundary's rendered
          position, NOT percentages — because the SVG stretches
          non-uniformly (preserveAspectRatio="none"), a percentage here
          wouldn't track the curve the way it does for `top`. Rescaled
          proportionally to the rail's new 285px width (was tuned for
          220px: 172px, 178px) so the nodes still land on the boundary
          rather than drifting into open space now that the shell is
          wider. */}
      <span
        key={`node-a-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '19%', left: '223px', ['--node-delay' as string]: '0s' }}
        aria-hidden="true"
      />
      <span
        key={`node-b-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '59%', left: '231px', ['--node-delay' as string]: '0.6s' }}
        aria-hidden="true"
      />

      {/* The one piece of state the rail was missing at a glance: which
          destination you're on, readable from the shell's own edge rather
          than only from the item's glow. Because it's a single element
          whose top/height transition, moving between pages reads as the
          marker travelling down the rail. */}
      {indicator && (
        <span
          className={styles.activeIndicator}
          style={{ top: `${indicator.top}px`, height: `${indicator.height}px` }}
          aria-hidden="true"
        />
      )}

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
        <Icon name={collapsed ? 'chevron' : 'chevron-left'} size={16} />
      </button>
      <ul className={styles.list} ref={listRef} onKeyDown={handleKeyDown}>
        {primaryItems.map((item, index) => {
          const active = isActive(item.href)
          const startsGroup = !isMobile && index > 0 && GROUP_STARTS.has(item.id)
          return [
            startsGroup ? (
              <li key={`sep-${item.id}`} className={styles.divider} role="separator" />
            ) : null,
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
                  {active && <span className={styles.iconHalo} aria-hidden="true" />}
                  {/* 10-foot-interface pass: default strokeWidth (1.6) read as
                      thin/washed-out at the larger 56px badge size — bumped to
                      2.1 so the glyph itself carries real visual weight,
                      matching "increase icon visibility and stroke weight." */}
                  <Icon name={item.icon} strokeWidth={2.1} />
                </span>
                <span className={styles.label}>
                  {item.label}
                  {active && <span className={styles.dot} aria-hidden="true" />}
                </span>
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
          ]
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
