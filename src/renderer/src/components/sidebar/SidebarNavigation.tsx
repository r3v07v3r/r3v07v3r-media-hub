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
  const [indicator, setIndicator] = useState<{
    top: number
    height: number
    left: number
    width: number
  } | null>(null)
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
  //  2. The active pill's position — a single element that slides
  //     between items, so switching pages reads as one continuous
  //     movement instead of a highlight blinking out here and in there.
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
    // The pill is exactly the row's own box — which is why .list lays its
    // rows out at their content width (align-items: flex-start) rather
    // than stretching them: a fixed-width pill has to be wide enough for
    // "Downloads", and at that width it overhung the organic boundary on
    // the rows where the wave pulls inward. Hugging each row means the
    // pill is only ever as wide as that row actually needs, and it stays
    // inside the shape everywhere.
    const next = {
      top: row.offsetTop,
      height: row.offsetHeight,
      left: row.offsetLeft,
      width: row.offsetWidth
    }
    setIndicator((prev) =>
      prev &&
      Math.abs(prev.top - next.top) < 0.5 &&
      Math.abs(prev.height - next.height) < 0.5 &&
      Math.abs(prev.left - next.left) < 0.5 &&
      Math.abs(prev.width - next.width) < 0.5
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
            {/* Reference pass: pulled back down (0.86/0.58 -> 0.5/0.2).
                The shell there is barely more than a tint over the page
                with a bright line drawn on it, and the dense fill was
                what made a label or pill crossing the boundary look
                broken — with the fill this light there's no hard panel
                edge for anything to visibly cross. The edge stroke
                (.railShapeEdge) was brightened to take over defining the
                silhouette. */}
            <stop offset="0%" stopColor="#0a1220" stopOpacity="0.5" />
            <stop offset="65%" stopColor="#050a14" stopOpacity="0.2" />
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
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000 Z"
          fill="url(#railFillGrad)"
        />
        <path
          className={styles.railShapeShadow}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000 Z"
          fill="url(#railInnerShadow)"
        />
        <path
          className={styles.railShapeSheen}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000 Z"
          fill="url(#railGlassSheen)"
        />
        <path
          className={styles.railShapeInnerGlow}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000 Z"
          fill="url(#railInnerGlowGrad)"
        />
        <path
          className={styles.railShapeEdge}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className={styles.railShapeTravel}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* A second, dimmer, violet-tinted highlight travelling the same
            boundary at a different offset/speed — "occasional travelling
            energy highlights" (plural), not just one lone cyan dash. */}
        <path
          className={styles.railShapeTravel2}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* Third highlight — a slower, occasional brighter flare rather
            than a third always-visible dash (see .railShapeTravel3's
            keyframe: mostly transparent, one brief bright pulse per
            loop). "Add occasional brighter travelling highlights." */}
        <path
          className={styles.railShapeTravel3}
          d="M0,0 C60,0 148,22 172,62 C202,110 230,142 230,190 C230,238 210,256 204,288 C198,318 202,358 208,394 C214,430 219,460 209,495 C201,524 202,556 208,590 C214,620 219,650 209,686 C201,716 202,746 207,776 C213,810 220,850 210,894 C200,930 154,962 94,982 C50,995 20,1000 0,1000"
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
      {/* `left` is a percentage of the rail's width, which lands these on
          the boundary at ANY rail width. preserveAspectRatio="none" does
          make the SVG stretch non-uniformly, but only the VERTICAL axis
          is decoupled from the viewBox — horizontally x_px is exactly
          (x_viewBox / 245) x railWidth, so a percentage tracks the curve
          precisely. These were previously absolute px, re-tuned by hand
          on every width change (220 -> 285 -> 230), which is what kept
          leaving them stranded off the curve; 78.2% / 81.1% are the same
          two points the 285px-era values described. */}
      <span
        key={`node-a-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '19%', left: '78.2%', ['--node-delay' as string]: '0s' }}
        aria-hidden="true"
      />
      <span
        key={`node-b-${pathname}`}
        className={`${styles.railNode} ${styles.railNodePulse}`}
        style={{ top: '59%', left: '81.1%', ['--node-delay' as string]: '0.6s' }}
        aria-hidden="true"
      />

      {/* Which destination you're on, stated by a lit pill behind the row
          rather than only by the icon's glow. One element whose top and
          height transition, so moving between pages reads as the pill
          travelling down the rail. */}
      {indicator && (
        <span
          className={styles.activePill}
          style={{
            top: `${indicator.top}px`,
            height: `${indicator.height}px`,
            left: `${indicator.left}px`,
            width: `${indicator.width}px`
          }}
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
                  {active && <span className={styles.iconHalo} aria-hidden="true" />}
                  {/* 2.1 was tuned to keep the glyph from looking thin inside a
                      56px badge; at the reference's ~40px badge that same weight
                      reads as heavy and closes up the icons' interiors. */}
                  <Icon name={item.icon} strokeWidth={1.7} />
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
