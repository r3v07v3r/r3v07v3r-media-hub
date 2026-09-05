# Requirements

This is the authoritative statement of what the current implementation task is. Both the implementer (Claude) and the reviewer (GPT) read this file — nothing discussed only in chat is binding on either of them. Replace the contents below with the real current task before running `npm run ai:review` or `npm run ai:loop`.

There is no active task queued right now — this is the template. A worked example is included at the bottom for reference; delete it once you've written a real entry.

## Functional requirements

- (What must work, precisely enough that "does this satisfy the requirement" is a factual question, not a matter of taste.)

## Visual requirements

- (What it must look like. Reference a screenshot in `.ai/screenshots/reference/` by name where possible, e.g. "match `.ai/screenshots/reference/dashboard.png`.")

## Constraints

- (What must NOT change. Explicitly list anything off-limits — e.g. "do not touch navigation logic," "do not change card count," "do not redesign unrelated areas.")

---

## Example (for reference — delete before writing a real requirement)

### Functional requirements

- Clicking a Continue Watching thumbnail resumes playback from the saved progress position.
- The mood selector row must remain keyboard-navigable (arrow keys move focus between pills).

### Visual requirements

- Hero artwork should occupy the right 55–60% of the hero area, fading to black toward the left edge. Match `.ai/screenshots/reference/dashboard.png`.
- Recommendation cards keep their current width; only the image aspect ratio changes.

### Constraints

- Do not touch responsive breakpoints, navigation logic, or card count.
- Do not redesign the page — match the reference visually, nothing more.
