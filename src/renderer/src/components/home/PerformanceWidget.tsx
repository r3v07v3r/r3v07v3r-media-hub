'use client'

import { useEffect, useState } from 'react'
import { usePerformanceMetrics } from '@renderer/hooks/usePerformanceMetrics'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './PerformanceWidget.module.css'

const R = 16
const CIRC = 2 * Math.PI * R

// Gauge fill shifts from cyan (idle) toward amber (high load) rather than
// staying a flat blue regardless of value — "gradually" per spec, so this
// is a smooth interpolation, not a threshold snap.
function gaugeColor(value: number) {
  const t = Math.min(1, Math.max(0, (value - 50) / 45))
  const cyan = [56, 193, 255]
  const amber = [255, 176, 56]
  const rgb = cyan.map((c, i) => Math.round(c + (amber[i] - c) * t))
  return `rgb(${rgb.join(',')})`
}

function Gauge({
  label,
  value,
  icon,
  pulseDelay
}: {
  label: string
  value: number
  icon: string
  pulseDelay: string
}) {
  const offset = CIRC - (Math.min(100, Math.max(0, value)) / 100) * CIRC
  const color = gaugeColor(value)
  return (
    <div className={styles.gauge}>
      <span className={styles.gaugeRingWrap} style={{ color }}>
        <svg className={styles.gaugeRing} viewBox="0 0 38 38">
          <circle className={styles.gaugeTrack} cx="19" cy="19" r={R} />
          <circle
            className={styles.gaugeFill}
            cx="19"
            cy="19"
            r={R}
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            style={{ stroke: color }}
          />
        </svg>
        {/* Small energy pulse travelling around each gauge occasionally
            (motion spec section 14) — the shared pulse-ring primitive,
            staggered per gauge so they don't all pulse in sync. */}
        <span
          className="pulse-ring"
          style={{ ['--pulse-delay' as string]: pulseDelay }}
          aria-hidden="true"
        />
        <span className={styles.gaugeLabel}>{Math.round(value)}%</span>
      </span>
      <span className={styles.gaugeName}>
        {/* 10-foot-interface pass: icon bumped alongside the gaugeName
            font-size increase (9px -> 12.5px) so the label icon doesn't
            end up visually undersized next to its now-larger text. */}
        <Icon name={icon} size={13} />
        {label}
      </span>
    </div>
  )
}

function GaugeStack({ metrics }: { metrics: ReturnType<typeof usePerformanceMetrics> }) {
  return (
    <>
      <Gauge label="CPU" value={metrics.cpu} icon="cpu" pulseDelay="0s" />
      <Gauge label="GPU" value={metrics.gpu} icon="gpu" pulseDelay="0.8s" />
      <Gauge label="RAM" value={metrics.ram} icon="ram" pulseDelay="1.6s" />
      <div className={styles.divider} />
      <div className={styles.net}>
        <span className={styles.netRow}>
          <Icon name="net" />↓ {metrics.netDownMbps.toFixed(1)} Mbps
        </span>
        <span className={styles.netRow}>
          <Icon name="net" />↑ {metrics.netUpMbps.toFixed(1)} Mbps
        </span>
      </div>
    </>
  )
}

export function PerformanceWidget() {
  const { performancePanelVisible } = useAppState()
  const metrics = usePerformanceMetrics()
  const [expanded, setExpanded] = useState(false)
  const [isCompact, setIsCompact] = useState(false)

  useEffect(() => {
    function apply() {
      setIsCompact(window.innerWidth <= 1099)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  if (!performancePanelVisible) return null

  const maxLoad = Math.round(Math.max(metrics.cpu, metrics.gpu, metrics.ram))
  // Edge brightens under load rather than staying a fixed intensity
  // (motion spec section 5/14: "occasionally brighten," "edge can
  // brighten based on system load").
  const highLoad = maxLoad >= 80

  return (
    <div
      className={`${styles.widget} glass-panel animated-edge ${highLoad ? 'edge-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setExpanded((v) => !v)
      }}
      aria-expanded={expanded}
      aria-label={
        isCompact ? 'System performance — tap to expand' : 'System performance — click for details'
      }
    >
      {isCompact ? (
        <>
          <span className={styles.compactSummary}>
            <Icon name="cpu" />
            {maxLoad}%
          </span>
          {expanded && (
            <div className={`${styles.popover} glass-panel`} onClick={(e) => e.stopPropagation()}>
              <GaugeStack metrics={metrics} />
            </div>
          )}
        </>
      ) : (
        <>
          <GaugeStack metrics={metrics} />
          {expanded && (
            <div className={styles.detail}>
              <span>CPU {metrics.cpu.toFixed(1)}%</span>
              <span>GPU {metrics.gpu.toFixed(1)}%</span>
              <span>RAM {metrics.ram.toFixed(1)}%</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
