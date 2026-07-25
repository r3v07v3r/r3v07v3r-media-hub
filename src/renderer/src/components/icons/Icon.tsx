// Minimal hand-drawn stroke-icon set (no external deps / no network
// calls), carried over from the previous build and extended with the
// handful of new glyphs this spec's chrome needs (weather, context menu
// actions, waveform, etc).

const PATHS: Record<string, string> = {
  home: '<path d="M4 12L12 5l8 7"/><path d="M6 10.5V20a1 1 0 0 0 1 1h4v-5h2v5h4a1 1 0 0 0 1-1v-9.5"/>',
  movies:
    '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 9h17M8 5.5V9M16 5.5V9"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M12 18v3"/>',
  live: '<circle cx="12" cy="12" r="2.6"/><path d="M7.5 7.5a7 7 0 0 0 0 9M16.5 7.5a7 7 0 0 1 0 9M4.5 4.5a11 11 0 0 0 0 15M19.5 4.5a11 11 0 0 1 0 15"/>',
  sports: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/>',
  music:
    '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/><path d="M9 17.5V6l10.5-2v11.5"/>',
  mystuff: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 4v5.5"/>',
  downloads:
    '<path d="M12 3.5v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 16.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/>',
  tracked: '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1z"/>',
  calendar:
    '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><circle cx="8" cy="14.2" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="14.2" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="14.2" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="17.4" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="17.4" r="1" fill="currentColor" stroke="none"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.9a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 3 12.46H2.9a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.55 7.35a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 6.98 2.6l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V1.3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 2.94a1.7 1.7 0 0 0 1.87-.34l.06-.06A2 2 0 1 1 20.16 5.4l-.06.06a1.7 1.7 0 0 0-.34 1.87V7.4a1.7 1.7 0 0 0 1.56 1.04h.19a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.04Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  weather:
    '<circle cx="9" cy="10.5" r="4"/><path d="M9 3v1.4M9 15.6V17M3 10.5h1.4M12.6 10.5H14M4.9 5.9l1 1M12.1 5.9l-1 1M4.9 15.1l1-1M12.1 15.1l-1-1"/><path d="M11 16.5h6a3 3 0 0 0 .6-5.94A5 5 0 0 0 8.2 8.9"/>',
  'play-outline': '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l6 3.5-6 3.5v-7z"/>',
  stack:
    '<path d="M12 3.5l8.5 4.4L12 12.3 3.5 7.9 12 3.5z"/><path d="M3.5 12.1l8.5 4.4 8.5-4.4M3.5 16.3l8.5 4.4 8.5-4.4"/>',
  play: '<path d="M7 4.5v15l13-7.5-13-7.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sparkle:
    '<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.4L12 17l-1.8-5.6L4.5 10l5.7-1.4L12 3z"/><path d="M19 15l.8 2.3L22 18l-2.2.7L19 21l-.8-2.3L16 18l2.2-.7L19 15z"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron-up': '<path d="M5 15l7-7 7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5z"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  pause:
    '<rect x="6" y="4.5" width="4.5" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4.5" height="15" rx="1.2"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="3" y="10" width="2" height="4"/><rect x="19" y="10" width="2" height="4"/><rect x="10" y="3" width="4" height="2"/><rect x="10" y="19" width="4" height="2"/>',
  gpu: '<rect x="3" y="8" width="18" height="9" rx="1.5"/><circle cx="8" cy="12.5" r="2"/><path d="M13 12.5h5M3 20h4"/>',
  ram: '<rect x="4" y="7" width="16" height="10" rx="1.5"/><path d="M8 7v-2M12 7v-2M16 7v-2M8 19v-2M12 19v-2M16 19v-2"/>',
  net: '<path d="M4 9a12 12 0 0 1 16 0M7 12.3a8 8 0 0 1 10 0M10.2 15.6a4 4 0 0 1 3.6 0"/><circle cx="12" cy="19" r="1.2"/>',
  pulse: '<path d="M2.5 12h4l2-6 4 14 2.5-11 1.5 3h5"/>',
  heart:
    '<path d="M12 20.2s-7.2-4.6-9.7-9.2C.9 7.9 2.4 4.5 5.7 3.7c2-.5 3.9.4 5 2 .1.1.2.3.3.5.1-.2.2-.4.3-.5 1.1-1.6 3-2.5 5-2 3.3.8 4.8 4.2 3.4 7.3-2.5 4.6-9.7 9.2-9.7 9.2z"/>',
  planet:
    '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-18 12 12)"/>',
  smiley:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="8.7" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.3" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M7.5 14.2c1 1.5 2.6 2.3 4.5 2.3s3.5-.8 4.5-2.3"/>',
  people:
    '<circle cx="8.5" cy="8.5" r="3"/><circle cx="16" cy="9.5" r="2.4"/><path d="M2.8 19.5c.5-3.2 2.8-5.3 5.7-5.3s5.2 2.1 5.7 5.3"/><path d="M14.8 14.6c2.3.2 4.1 2 4.5 4.9"/>',
  lightning: '<path d="M13 2.5 4.5 14h5.5l-1 7.5L18 10h-5.5l.5-7.5z"/>',
  waveform: '<path d="M2 12h2.5M6 8v8M9.5 4v16M13 8v8M16.5 2v20M20 9v6M22 12h-.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5-5"/>',
  x: '<path d="M5 5l14 14M19 5L5 19"/>',
  'thumbs-down':
    '<path d="M7 14V3M3 14h3.2a2 2 0 0 1 1.9 1.4l1 3.1a2 2 0 0 0 3.8-.9v-3.6H18a2 2 0 0 0 2-2.4l-1.3-6A2 2 0 0 0 16.7 4H7"/>',
  'more-horizontal':
    '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none"/>',
  refresh:
    '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5"/>',
  trash:
    '<path d="M4 7h16M9 7V4.8A1.3 1.3 0 0 1 10.3 3.5h3.4A1.3 1.3 0 0 1 15 4.8V7M18.5 7l-.7 12.4a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5.5 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a15.7 15.7 0 0 1-3.4 4.3M6.6 6.6C4 8.3 2 12 2 12s3.5 7 10 7a10.4 10.4 0 0 0 3.4-.6"/><path d="M9.9 10a3 3 0 0 0 4.1 4.1"/>',
  wifi: '<path d="M4 9a12 12 0 0 1 16 0M7 12.3a8 8 0 0 1 10 0M10.2 15.6a4 4 0 0 1 3.6 0"/><circle cx="12" cy="19" r="1.2"/>',
  'wifi-off':
    '<path d="M2 2l20 20"/><path d="M8.5 5.5A12 12 0 0 1 20 9M4 9a12 12 0 0 1 2.2-1.8M7 12.3a8 8 0 0 1 9 1.6M10.2 15.6a4 4 0 0 1 3.6 0"/><circle cx="12" cy="19" r="1.2"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>'
}

interface IconProps {
  name: string
  className?: string
  size?: number
  strokeWidth?: number
  style?: React.CSSProperties
}

export function Icon({ name, className, size, strokeWidth = 1.6, style }: IconProps) {
  const body = PATHS[name] || ''
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      style={style}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}
