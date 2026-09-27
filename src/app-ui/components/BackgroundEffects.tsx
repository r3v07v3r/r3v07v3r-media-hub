import './BackgroundEffects.css'

/**
 * The desktop's backdrop (src/renderer/src/components/layout/
 * BackgroundEffects.tsx), for the phone and TV: the same painted nebula,
 * star field, colour washes and faint travelling circuit line.
 *
 * Made cheaper for a phone or a budget TV box: the washes are soft radial
 * gradients rather than blur() filters (a 90px blur over half the screen is
 * a GPU cost a TV SoC notices), the pulse has no glow filter, and only
 * transforms and opacity animate. prefers-reduced-motion stills it all.
 * Hidden on the player screen, where the video is behind the page.
 */
export default function BackgroundEffects() {
  const circuit =
    'M-50,180 C250,180 250,320 550,320 C850,320 850,120 1150,120 C1350,120 1400,220 1650,220'
  const circuit2 =
    'M-50,720 C300,720 300,560 620,560 C980,560 980,780 1300,780 C1450,780 1500,700 1650,700'
  return (
    <div className="app-bg" aria-hidden="true">
      <div className="app-bg__nebula" />
      <div className="app-bg__stars" />
      <div className="app-bg__wash app-bg__wash--blue" />
      <div className="app-bg__wash app-bg__wash--violet" />
      <svg className="app-bg__circuit" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <path className="app-bg__trace" d={circuit} pathLength={1} />
        <path className="app-bg__pulse" d={circuit} pathLength={1} />
        <path className="app-bg__trace" d={circuit2} pathLength={1} />
        <path className="app-bg__pulse app-bg__pulse--late" d={circuit2} pathLength={1} />
      </svg>
      <div className="app-bg__vignette" />
    </div>
  )
}
