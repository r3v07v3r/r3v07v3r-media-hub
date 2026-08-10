export interface FloatingPanelPosition {
  left: number
  top: number
}

/** Keeps a floating panel inside the visible viewport, including when the
 * pointer is close to an edge or the viewport is smaller than the panel. */
export function positionFloatingPanel(
  x: number,
  y: number,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8
): FloatingPanelPosition {
  const maxLeft = Math.max(margin, viewportWidth - panelWidth - margin)
  const maxTop = Math.max(margin, viewportHeight - panelHeight - margin)
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop))
  }
}
