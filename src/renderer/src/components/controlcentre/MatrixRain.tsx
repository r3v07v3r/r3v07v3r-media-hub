'use client'

// Falling glyphs behind the control centre.
//
// ONE CANVAS, not elements. A column of DOM nodes per stream would be a few
// hundred layers being restyled every frame, which is a real cost on the
// machines this runs on for something nobody is looking directly at. A
// single 2D canvas draws the whole field in one pass.
//
// IT NEVER TOUCHES USABILITY. It is pointer-events: none, sits behind every
// control, and paints at low alpha — the surface's own contrast is unchanged
// with the canvas removed. The one thing decoration must not do is make a
// button harder to hit, so it cannot be hit at all.
//
// IT STOPS WHEN NOBODY CAN SEE IT. Not running while the cube is turned away
// is most of the saving here: the control centre is a second face that
// exists all the time and is looked at rarely, so the default state of this
// effect is "off".

import { useEffect, useRef } from 'react'
import { useMotionSuspended } from '@renderer/hooks/useMotionSuspended'
import { useMotionUserDisabled } from '@renderer/hooks/useMotionUserDisabled'
import styles from './MatrixRain.module.css'

/**
 * Katakana, digits and a few Latin glyphs — the alphabet the effect is known
 * for. Deliberately not the app's own text: recognisable words in the
 * background read as something to try to read, which is a distraction rather
 * than an atmosphere.
 */
const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFZ:."=*+-<>'

/** Rain reads correctly at a fraction of display rate, and every frame not
 *  drawn is battery. 14 is fast enough to flow and slow enough that each
 *  character is on screen long enough to be read as a character. */
const FPS = 14
const FRAME_MS = 1000 / FPS

const FONT_SIZE = 15
/** Chance per frame that a column that has run off the bottom restarts.
 *  Below 1 so the columns desynchronise on their own instead of marching in
 *  a rank, which is what makes it look like rain rather than a wipe. */
const RESTART_CHANCE = 0.975

interface Props {
  /** The cube face this sits on is only looked at while the control centre
   *  is open; the rest of the time it is turned away from the viewer. */
  active: boolean
}

export function MatrixRain({ active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const suspended = useMotionSuspended()
  const userDisabled = useMotionUserDisabled()
  const running = active && !suspended && !userDisabled

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !running) return
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return

    let columns: number[] = []
    let width = 0
    let height = 0
    let frame = 0
    let last = 0

    // Backing store in device pixels, drawing in CSS pixels — without this
    // the glyphs are soft on any display above 1x, which on a effect made of
    // small text is the difference between "rain" and "smudge".
    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.font = `${FONT_SIZE}px "Courier New", ui-monospace, monospace`
      context.textBaseline = 'top'
      const count = Math.ceil(width / FONT_SIZE)
      columns = Array.from({ length: count }, () =>
        // Seeded above the top edge by a random amount, so the first frame
        // is already a field in motion rather than a row starting together.
        Math.floor((Math.random() * -height) / FONT_SIZE)
      )
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = (now: number): void => {
      frame = window.requestAnimationFrame(draw)
      if (now - last < FRAME_MS) return
      last = now

      // THE TRAIL, and it has to be destination-out.
      //
      // The obvious version — paint the background over everything at low
      // alpha — does not fade anything on a transparent canvas. A
      // translucent source-over fill ADDS alpha: a pixel goes
      // 0.22 + 0.78a per frame, converging on opaque, so the colour drifts
      // toward the fill while the alpha channel saturates. Two things went
      // wrong with that. The canvas slowly became a solid dark slab over the
      // panel behind it, and the glyphs never actually left — measured at 25
      // rows of trail, the entire height of the face, which is exactly the
      // vertical lines this was meant to be.
      //
      // destination-out multiplies the existing alpha instead: a becomes
      // 0.78a, true exponential decay to genuinely transparent. Ten or so
      // frames to invisibility, one row per frame, so the tail is about ten
      // glyphs — the length that reads as rain.
      context.globalCompositeOperation = "destination-out"
      context.fillStyle = "rgba(0, 0, 0, 0.22)"
      context.fillRect(0, 0, width, height)
      context.globalCompositeOperation = "source-over"

      for (let i = 0; i < columns.length; i++) {
        const x = i * FONT_SIZE
        const y = columns[i] * FONT_SIZE

        // ONE glyph per column per frame, at the head. Drawing a second at
        // the previous row painted a different random character over one
        // already there, so every position was struck twice with different
        // ink — which is what smeared the characters into a streak. The fade
        // above is what makes the tail; it does not need help.
        context.fillStyle = 'rgba(205, 255, 235, 0.92)'
        context.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x, y)

        if (y > height && Math.random() > RESTART_CHANCE) columns[i] = 0
        else columns[i]++
      }
    }

    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      // Left blank rather than mid-field, so re-opening starts fresh instead
      // of flashing the last frame from minutes ago.
      context.clearRect(0, 0, width, height)
    }
  }, [running])

  return <canvas ref={canvasRef} className={styles.rain} aria-hidden="true" />
}
