import './Spinner.css'

/**
 * The one visual sign, on every screen, that something is in flight rather
 * than empty or broken — see the task brief: a user must always be able to
 * tell "loading" from "empty" from "failed". `label` is spoken by a screen
 * reader via `role="status"`; sighted users never see it (the surrounding
 * StatusNote/button text already says the same thing visually wherever
 * one is needed).
 */
export default function Spinner({
  size = 'md',
  label = 'Loading'
}: {
  size?: 'sm' | 'md'
  label?: string
}) {
  return (
    <span className={`spinner spinner--${size}`} role="status">
      <span className="visually-hidden">{label}</span>
    </span>
  )
}
