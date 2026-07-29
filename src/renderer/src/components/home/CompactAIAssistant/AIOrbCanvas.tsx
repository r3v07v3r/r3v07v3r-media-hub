import { useEffect, useRef } from 'react'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { useMotionSuspended } from '@renderer/hooks/useMotionSuspended'
import styles from './CompactAIAssistant.module.css'

// Procedural Canvas 2D swirling-energy texture for the AI orb — CSS alone
// can't produce the layered, organic "plasma" motion the reference calls
// for (rotating filament, drifting particles, soft bloom), so this paints
// it frame-by-frame instead of relying on a single rotating static image.
// Canvas 2D rather than WebGL: at this element size (~130px) the visual
// payoff of a shader doesn't outweigh the added complexity/GPU context
// management, and 2D compositing (`lighter` blend mode) already gets the
// additive-glow look a shader would otherwise be needed for.

type Tone = 'idle' | 'listening' | 'processing' | 'responding' | 'error'

const PALETTES: Record<Tone, { a: string; b: string; c: string; speed: number }> = {
  idle: { a: '#3fb2ff', b: '#8b6bff', c: '#1fc9ff', speed: 1 },
  listening: { a: '#38e5ff', b: '#8b6bff', c: '#3fb2ff', speed: 2.2 },
  processing: { a: '#a943ff', b: '#ef569c', c: '#8b6bff', speed: 3.4 },
  responding: { a: '#ffffff', b: '#3fb2ff', c: '#8b6bff', speed: 1.5 },
  error: { a: '#ff7a60', b: '#ff5a5a', c: '#ff9a3d', speed: 2.6 }
}

interface Particle {
  angle: number
  radius: number
  speed: number
  size: number
  phase: number
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function AIOrbCanvas({ tone = 'idle' }: { tone?: Tone }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useReducedMotion()
  // Unlike the CSS animations elsewhere (paused in one shot via global.css's
  // [data-motion-suspended] rule), this rAF loop is JS-driven and can't be
  // reached by that CSS — it needs its own check for the same "nothing to
  // see it" condition (window hidden/minimized, or a movie playing
  // full-screen over this still-mounted page).
  const motionSuspended = useMotionSuspended()
  const toneRef = useRef(tone)
  // Mutating a ref during render is impure (React may re-invoke render
  // without side effects, e.g. under StrictMode's double-render) — the
  // animation loop below only ever reads toneRef.current from inside its
  // requestAnimationFrame callback, so syncing it in an effect is both
  // correct and still picks up every `tone` change immediately.
  useEffect(() => {
    toneRef.current = tone
  }, [tone])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Matches .orbCanvas's new display size (see CompactAIAssistant.module
    // .css — the orb grew from a 128px to a ~302px box) so the bitmap
    // renders at native resolution instead of being upscaled/blurred.
    const size = 220
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    // Refinement pass: fewer particles (18 -> 12) and each one dimmer
    // (see the twinkle fill-alpha below) — "reduce visual noise" without
    // losing the drifting-particle effect entirely.
    const PARTICLE_COUNT = 12
    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      angle: (i / PARTICLE_COUNT) * Math.PI * 2,
      radius: 48 + Math.random() * 42,
      speed: 0.15 + Math.random() * 0.25,
      size: 0.9 + Math.random() * 2.2,
      phase: Math.random() * Math.PI * 2
    }))

    let raf = 0
    let t = 0
    const cx = size / 2
    const cy = size / 2

    function frame() {
      if (!ctx) return
      const palette = PALETTES[toneRef.current]
      const [ra, ga, ba] = hexToRgb(palette.a)
      const [rb, gb, bb] = hexToRgb(palette.b)
      const [rc, gc, bc] = hexToRgb(palette.c)

      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, size / 2 - 2, 0, Math.PI * 2)
      ctx.clip()

      // Deep base fill so the swirl reads against something other than
      // full transparency (the surrounding .orbCore/.orbRing sit on top).
      ctx.fillStyle = 'rgba(4, 8, 18, 0.9)'
      ctx.fillRect(0, 0, size, size)

      ctx.globalCompositeOperation = 'lighter'

      // Two counter-rotating swirl lobes — the "rotating filament" effect,
      // built from elongated radial gradients rather than a literal line
      // so it reads as glowing plasma rather than a hard-edged spoke.
      const swirl = t * 0.0006 * palette.speed
      for (let i = 0; i < 2; i++) {
        const dir = i === 0 ? 1 : -1
        const angle = swirl * dir + (i * Math.PI) / 2
        const lobeX = cx + Math.cos(angle) * 31
        const lobeY = cy + Math.sin(angle) * 31
        const grad = ctx.createRadialGradient(lobeX, lobeY, 0, lobeX, lobeY, 79)
        const [r, g, b] = i === 0 ? [ra, ga, ba] : [rb, gb, bb]
        // Refinement pass: ~13% dimmer swirl lobes (0.62/0.22 -> 0.54/0.19).
        // Second refinement pass: another ~10% (0.54/0.19 -> 0.49/0.17).
        grad.addColorStop(0, `rgba(${r},${g},${b},0.49)`)
        grad.addColorStop(0.5, `rgba(${r},${g},${b},0.17)`)
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, size, size)
      }

      // Slow central core bloom (refinement pass: 0.5 -> 0.43 -> 0.39, ~10% further)
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 52)
      coreGrad.addColorStop(0, `rgba(${rc},${gc},${bc},0.39)`)
      coreGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = coreGrad
      ctx.fillRect(0, 0, size, size)

      // Drifting particles — small additive dots orbiting at varying
      // radii/speeds, twinkling via a sine-driven opacity.
      for (const p of particles) {
        const a = p.angle + t * 0.001 * p.speed * palette.speed
        const wobble = Math.sin(t * 0.002 + p.phase) * 4
        const px = cx + Math.cos(a) * (p.radius + wobble)
        const py = cy + Math.sin(a) * (p.radius + wobble)
        const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.003 + p.phase * 2))
        ctx.beginPath()
        ctx.arc(px, py, p.size, 0, Math.PI * 2)
        // Refinement pass: dimmer particles (0.8 -> 0.68 -> 0.61 multiplier, ~10% further).
        ctx.fillStyle = `rgba(${rc},${gc},${bc},${twinkle * 0.61})`
        ctx.fill()
      }

      ctx.restore()

      if (!reducedMotion && !motionSuspended) {
        t += 16
        raf = requestAnimationFrame(frame)
      }
    }

    frame()
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion, motionSuspended])

  return <canvas ref={canvasRef} className={styles.orbCanvas} aria-hidden="true" />
}
