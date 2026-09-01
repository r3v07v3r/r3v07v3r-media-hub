import { useEffect, useRef, useState } from 'react'
import { motion, useAnimationControls } from 'framer-motion'
import { BackgroundEffects } from './BackgroundEffects'
import { TopUtilityBar } from '@renderer/components/topbar/TopUtilityBar'
import { SidebarNavigation } from '@renderer/components/sidebar/SidebarNavigation'
import { GlobalOverlays } from '@renderer/components/overlays/GlobalOverlays'
import { ControlCentreFace } from '@renderer/components/controlcentre/ControlCentreFace'
import { useMotionSuspended } from '@renderer/hooks/useMotionSuspended'
import { useMotionUserDisabled } from '@renderer/hooks/useMotionUserDisabled'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  CLOSE_DURATION,
  CLOSE_EASES,
  CLOSE_KEYFRAMES,
  CLOSE_TIMES,
  OPEN_DURATION,
  OPEN_EASES,
  OPEN_KEYFRAMES,
  OPEN_TIMES
} from '@renderer/components/controlcentre/cubeMotion'
import styles from './AppShell.module.css'

export function AppShell({ children }: { children: React.ReactNode }) {
  // A single global switch for every decorative CSS animation in the app
  // (sidebar highlights, background blobs, shimmer, halo pulses, ...) —
  // see global.css's `[data-motion-suspended='true'] *` rule. Cheaper and
  // far less invasive than teaching every individual component's CSS
  // module about visibility/playback state; this is the one place that
  // needs to know, and a data attribute is all the rest need to react to.
  const motionSuspended = useMotionSuspended()
  useEffect(() => {
    document.documentElement.dataset.motionSuspended = motionSuspended ? 'true' : 'false'
  }, [motionSuspended])

  // Same idea, driven by the standing Settings > More Options toggle
  // instead of the automatic hidden/playing check above — see
  // useMotionUserDisabled's own comment.
  const motionUserDisabled = useMotionUserDisabled()
  useEffect(() => {
    document.documentElement.dataset.motionUserDisabled = motionUserDisabled ? 'true' : 'false'
  }, [motionUserDisabled])

  const { controlCentreOpen, mediaHubSettings, playbackMedia, partyPanelOpen } = useAppState()

  // While a film plays, the video is an embedded native child window covering
  // this whole document — every pixel of the page is invisible, but the page
  // can still be HIT: mpv's embedded child processes no mouse input, so in
  // the moments the controls overlay is not there to take a click (it is
  // created and revealed asynchronously around the load, and hidden with the
  // party hub), the click would land on whatever invisible element happens
  // to be underneath and quietly navigate the app under the film. Refuse
  // pointer events for the duration instead (global.css's
  // [data-playback-covered='true'] rule).
  //
  // The watch-party hub is the exception: it deliberately hides the video to
  // show main-window UI, which must stay clickable — so the attribute follows
  // "covered", not "playing".
  const playbackCovered = Boolean(playbackMedia) && !partyPanelOpen
  useEffect(() => {
    document.documentElement.dataset.playbackCovered = playbackCovered ? 'true' : 'false'
  }, [playbackCovered])

  /**
   * A first-run dialog is up — the welcome flow (WelcomeSetup) or the
   * storage question (StoragePolicyPrompt), which run in that order.
   *
   * Both faces go inert while one is: the scrim stops a mouse, but a
   * keyboard or a screen reader would otherwise walk straight into the app
   * behind it and could start playing something — and an unanswered policy
   * still resolves to the disk default, so video would be written before
   * the question governing it had been answered. Same conditions the two
   * prompts render on; they hold focus, this makes everything else
   * unreachable.
   */
  const firstRunBlocking =
    Boolean(mediaHubSettings) &&
    (!mediaHubSettings?.setupComplete || !mediaHubSettings?.storagePolicyChosen)
  useEffect(() => {
    document.documentElement.dataset.controlCentre = controlCentreOpen ? 'true' : 'false'
  }, [controlCentreOpen])

  // The settings face is mounted from the first open onward and then left
  // mounted. Rendering it always would build ~4,900 lines of settings UI (and
  // every subscription in it) for someone who never opens it; unmounting it
  // on close would leave the face BLANK for the whole roll-back, which is
  // exactly the illusion this structure exists to protect — a cube's far side
  // does not stop existing because it is facing away.
  //
  // State, not a ref: a ref written and read during render is unsafe under
  // concurrent rendering and StrictMode's double render (react-hooks/refs
  // flags it), and this value decides what gets rendered.
  //
  // Set during render rather than in an effect, which is legal for a
  // render-phase update to this same component and re-renders before paint.
  // An effect would mount the face one frame AFTER the rotation had already
  // started, so the first open would turn to a blank face.
  const [hasOpened, setHasOpened] = useState(false)
  if (controlCentreOpen && !hasOpened) setHasOpened(true)

  const motionOff = motionUserDisabled

  // The rotation is driven IMPERATIVELY, not derived from render state, and
  // that is a correctness requirement rather than a style choice.
  //
  // Keyframes describe a transition, so they must run exactly once per
  // toggle. Putting them in `animate` means every render re-asserts them —
  // and AppStateContext re-renders often — so an unrelated state change
  // replayed the whole closing turn. Seen live: the app booted with the cube
  // frozen at rotateX(-81deg) and an empty window, because the close
  // animation had started on mount.
  //
  // A ref holding the PREVIOUS open state is what distinguishes the three
  // cases: first mount (set the angle, no animation), a real toggle (run the
  // keyframes), and any other render (do nothing at all).
  const controls = useAnimationControls()
  const prevOpen = useRef<boolean | null>(null)
  useEffect(() => {
    const angle = controlCentreOpen ? -90 : 0
    if (prevOpen.current === null || motionOff) {
      controls.set({ rotateX: angle })
    } else if (prevOpen.current !== controlCentreOpen) {
      void controls.start({
        rotateX: controlCentreOpen ? [...OPEN_KEYFRAMES] : [...CLOSE_KEYFRAMES],
        transition: controlCentreOpen
          ? { duration: OPEN_DURATION, times: [...OPEN_TIMES], ease: [...OPEN_EASES] }
          : { duration: CLOSE_DURATION, times: [...CLOSE_TIMES], ease: [...CLOSE_EASES] }
      })
    }
    prevOpen.current = controlCentreOpen
  }, [controlCentreOpen, motionOff, controls])

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {/* Outside the cube, both of them, and that is load-bearing rather than
          incidental: a transform on an ancestor becomes the containing block
          for every position:fixed descendant, and both of these are full of
          fixed elements (BackgroundEffects itself, and every overlay, toast
          and dialog under GlobalOverlays). Inside the cube they would be
          positioned against the rotating face instead of the viewport, and
          would rotate with it. */}
      <BackgroundEffects />
      {/* The divide. The bar is the edge the two faces share, so it sits
          above the cube and never rotates — which is what makes the app and
          the control centre read as two sides of one object hinged here,
          rather than as two screens being swapped. */}
      <div className={styles.topbar}>
        <TopUtilityBar />
      </div>
      <div className={styles.stage}>
        <motion.div
          className={styles.cube}
          // Pushed back by half the cube's depth so whichever face is forward
          // lands on the screen plane instead of being magnified toward the
          // viewer by the perspective.
          transformTemplate={({ rotateX }) => `translateZ(-50vh) rotateX(${rotateX})`}
          initial={false}
          animate={controls}
        >
          {/* Face one: the app itself. This is the grid that used to be on
              .shell, moved down a level so it can be a face. */}
          {/* aria-hidden AND inert. aria-hidden alone hid the app from a
              screen reader while leaving every control in it tabbable, so
              Tab from the control centre walked into a face that was
              physically turned away — the same rule ControlCentreFace
              already applies to itself in the other direction. */}
          <div
            className={`${styles.face} ${styles.faceApp}`}
            aria-hidden={controlCentreOpen || firstRunBlocking}
            inert={controlCentreOpen || firstRunBlocking}
          >
            <div className={`${styles.sidebar} thin-scroll`}>
              <SidebarNavigation />
            </div>
            <main id="main-content" className={styles.main} tabIndex={-1}>
              {children}
            </main>
          </div>
          {/* Face two: the control centre, hinged along the top edge that the
              bar sits on. */}
          <div
            className={`${styles.face} ${styles.faceSettings}`}
            aria-hidden={!controlCentreOpen || firstRunBlocking}
            // Cascades to ControlCentreFace's own inert inside it, so the
            // far face is unreachable whichever way the cube is turned.
            inert={firstRunBlocking}
          >
            {hasOpened && <ControlCentreFace />}
          </div>
        </motion.div>
      </div>
      <GlobalOverlays />
    </div>
  )
}
