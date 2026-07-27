import { useEffect, useRef, useState } from 'react'
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
    // Third refinement pass: expanded rail 220px -> 285px (see .rail in
    // SidebarNavigation.module.css) — kept in sync here since this is
    // the value MoodBrowser reads to know how far it can bleed left.
    // Collapsed 84 -> 90: matches .rail.collapsed's own width bump (see
    // that rule's comment — the icon orb didn't actually fit in 84px).
    const width = isMobile ? 0 : collapsed ? 90 : 285
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
