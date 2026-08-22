import { useAppState } from '@renderer/context/AppStateContext'
import { AIOrbCanvas } from './AIOrbCanvas'
import styles from './CompactAIAssistant.module.css'

const STATUS_LABEL: Record<string, string> = {
  idle: 'Ready',
  hover: 'Ready',
  focused: 'Ready',
  processing: 'Thinking…',
  responding: "Here's an idea",
  error: 'Something went wrong'
}

export function AIOrb() {
  const { assistantState } = useAppState()
  const cls = [
    styles.orbWrap,
    assistantState === 'processing' ? styles.processing : '',
    assistantState === 'responding' ? styles.responding : '',
    assistantState === 'error' ? styles.error : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} role="img" aria-label={`R3 AI assistant, ${STATUS_LABEL[assistantState]}`}>
      <svg className={styles.orbTrail} viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <radialGradient id="orbTrailGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#3fb2ff" stopOpacity="0.27" />
            <stop offset="100%" stopColor="#3fb2ff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="110" cy="110" r="95" fill="url(#orbTrailGrad)" />
      </svg>
      <div className={styles.orbHalo} aria-hidden="true" />
      {/* Bright white-blue core bloom — the sphere's single hottest point,
          under the swirl/canvas layers so they read as light moving
          through/around a lit centre rather than a flat painted disc. */}
      <div className={styles.orbCoreGlow} aria-hidden="true" />
      {/* Painted energy-sphere art (generated, not CSS) composited with
          mix-blend-mode: screen — its pure-black background disappears
          against the dark UI, leaving only the glowing swirl. Sits
          between the halo glow and the SVG ring/label so the ring still
          reads as a crisp state indicator on top. */}
      <div className={styles.orbImage} aria-hidden="true" />
      {/* Real-time Canvas 2D layer — rotating filament + drifting
          particles + core bloom, composited on top of the painted base
          via mix-blend-mode: screen (see AIOrbCanvas doc comment). CSS
          alone can't produce this genuinely animated plasma texture. */}
      <AIOrbCanvas
        tone={
          assistantState === 'processing' ||
          assistantState === 'responding' ||
          assistantState === 'error'
            ? assistantState
            : 'idle'
        }
      />
      {/* Translucent glass rim sitting on top of the swirl/canvas — reads
          as the sphere's own glassy surface catching light rather than
          another glow layer. */}
      <div className={styles.orbGlassRing} aria-hidden="true" />
      <svg className={styles.orbRing} viewBox="0 0 168 168" aria-hidden="true">
        <defs>
          <linearGradient id="orbRingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3fb2ff" />
            <stop offset="55%" stopColor="#8b6bff" />
            <stop offset="100%" stopColor="#3fb2ff" />
          </linearGradient>
        </defs>
        <g className={styles.orbRingSpin}>
          <circle
            cx="84"
            cy="84"
            r="72"
            fill="none"
            stroke="url(#orbRingGrad)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray="150 302"
            opacity="0.76"
          />
          <circle
            cx="84"
            cy="84"
            r="72"
            fill="none"
            stroke="url(#orbRingGrad)"
            strokeWidth="1"
            strokeLinecap="round"
            strokeDasharray="40 412"
            strokeDashoffset="-200"
            opacity="0.44"
          />
        </g>
      </svg>
      <div className={styles.orbCore}>
        <span className={styles.orbLabel}>R3 AI</span>
        <span className={styles.orbStatus}>{STATUS_LABEL[assistantState]}</span>
      </div>
    </div>
  )
}
