import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * Whether the control-centre panel a section lives in is the one on screen:
 * the cube turned toward the viewer AND that section selected.
 *
 * ControlCentreFace keeps every panel mounted for good once it has been
 * opened (see its comments: unmounting would throw away half-typed state),
 * so a section's polling used to run for the rest of the session — the
 * Caching figures every 15 s and the Services probes of every configured
 * service every 20 s, with the cube turned away or another section showing.
 *
 * Defaults to true, so a section rendered anywhere else (not inside the
 * face's provider) keeps polling exactly as before.
 */
export const PanelVisibleContext = createContext(true)

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

/**
 * True while this panel is on screen and the window is not minimised or
 * hidden. Polling effects gate on it and list it as a dependency, so they
 * stop when it goes false and refresh straight away when it comes back.
 */
export function usePanelVisible(): boolean {
  const panelVisible = useContext(PanelVisibleContext)
  const pageVisible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true)
  return panelVisible && pageVisible
}
