// How the cube turns.
//
// Extracted so AppShell (which owns the cube) and anything that needs to move
// in step with it read the same numbers. The shape here is the whole feel of
// the transition, so it is described rather than just declared.
//
// A single easing curve cannot say what this needs to say. The movement is
// three things in sequence: the face you are looking at tilts back slowly
// enough to read as a solid turning, then the cube swings through, then it
// almost CLICKS onto its next side and settles. An ease-out curve does the
// opposite — fastest at the start, so the tilt is over before you have seen
// it.
//
// So the rotation is keyframed, and `times` carries the meaning: the first
// third of the duration covers only 16 of the 90 degrees. That is the slow
// pull-back. The next third covers 62 — the swing. The last stretch
// overshoots four degrees past square and comes back, which is the click.
//
// Overshoot rather than a spring, deliberately: a spring's overshoot depends
// on velocity and duration and would land differently every time.

export const OPEN_DURATION = 0.78
export const OPEN_KEYFRAMES = [0, -16, -78, -94, -90]
export const OPEN_TIMES = [0, 0.36, 0.7, 0.87, 1]
/** Per-segment easing: easeIn while winding up, easeOut once it is falling
 *  into place. One curve across all four would flatten the distinction the
 *  keyframes exist to create. */
export const OPEN_EASES = ['easeIn', 'easeIn', 'easeOut', 'easeOut'] as const

/** The same shape reversed, so the cube visibly rolls back the way it came
 *  rather than snapping. Quicker — dismissal should not make you wait — but
 *  not so much quicker that it stops reading as the same object moving. */
export const CLOSE_DURATION = 0.6
export const CLOSE_KEYFRAMES = [-90, -94, -78, -16, 0]
export const CLOSE_TIMES = [0, 0.13, 0.3, 0.64, 1]
export const CLOSE_EASES = ['easeIn', 'easeIn', 'easeOut', 'easeOut'] as const
