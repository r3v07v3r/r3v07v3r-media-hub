// Fixes subtitles drifting out of sync after a seek during compatibility-
// mode playback. That mode restarts the ffmpeg transcode from the target
// position on every seek (see vlc.ts/PlaybackOverlay's streamStartOffsetRef
// comments) — the <video> element's own currentTime resets to ~0 for the
// new segment, but an external WebVTT <track>'s cue timestamps are baked in
// relative to the ORIGINAL, absolute media timeline and never move. The fix
// is to re-shift the original VTT's cues by the current segment offset
// every time that offset changes, rather than ever mutating the original.

const TIMING_LINE = /^([\d:.]+)\s*-->\s*([\d:.]+)(.*)$/

function parseVttTimestamp(value: string): number {
  const parts = value.trim().split(':')
  const last = parts[parts.length - 1] ?? '0'
  const [secondsPart, msPart] = last.split('.')
  const seconds = Number(secondsPart) || 0
  const ms = Number(msPart) || 0
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) || 0 : 0
  const hours = parts.length >= 3 ? Number(parts[parts.length - 3]) || 0 : 0
  return hours * 3600 + minutes * 60 + seconds + ms / 1000
}

function formatVttTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds)
  const ms = Math.round((clamped % 1) * 1000)
  const wholeSeconds = Math.floor(clamped)
  const h = Math.floor(wholeSeconds / 3600)
  const m = Math.floor((wholeSeconds % 3600) / 60)
  const s = wholeSeconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** Shifts every cue in `vtt` by `-offsetSeconds` (dropping any cue that
 *  would end at or before 0 — dialogue from before this segment's start,
 *  which would otherwise all pile up and flash at the very beginning). A
 *  zero offset returns the input unchanged rather than round-tripping it
 *  through parse/format, avoiding any accumulated precision drift. */
export function shiftVttCues(vtt: string, offsetSeconds: number): string {
  if (!offsetSeconds) return vtt
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n\n+/)
  const [header, ...rest] = blocks
  const kept: string[] = []
  for (const block of rest) {
    const lines = block.split('\n')
    const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line))
    if (timingIndex === -1) {
      kept.push(block)
      continue
    }
    const match = lines[timingIndex].match(TIMING_LINE)
    if (!match) {
      kept.push(block)
      continue
    }
    const end = parseVttTimestamp(match[2]) - offsetSeconds
    if (end <= 0) continue
    const start = parseVttTimestamp(match[1]) - offsetSeconds
    lines[timingIndex] = `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}${match[3]}`
    kept.push(lines.join('\n'))
  }
  return [header, ...kept].join('\n\n')
}

/** UTF-8-safe base64 decode/encode for `data:text/vtt;base64,...` URLs —
 *  plain atob/btoa mangle anything outside Latin1 (accents, non-Latin
 *  scripts are common in subtitle files), and this renderer has no Buffer
 *  (no Node integration in the page context, only what's exposed via
 *  contextBridge). */
export function decodeVttDataUrl(dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeVttDataUrl(vtt: string): string {
  const bytes = new TextEncoder().encode(vtt)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:text/vtt;base64,${btoa(binary)}`
}
