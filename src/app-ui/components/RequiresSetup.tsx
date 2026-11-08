import { useNavigate } from 'react-router-dom'
import StatusNote from './StatusNote'

/** "A or B", "A, B or C": how a list of services reads in a sentence. */
function joinServices(services: string[]): string {
  if (services.length <= 1) return services[0] ?? ''
  return `${services.slice(0, -1).join(', ')} or ${services[services.length - 1]}`
}

/**
 * The line a control shows instead of looking ready when what it needs is
 * not set up: "<what> requires <service> to be set up." and one button to
 * the place where it is set up — Settings, unless the caller names another.
 * On the phone some services (Simkl, a media server) are set up on the
 * computer and arrive by linking, so `detail` says where that happens.
 */
export default function RequiresSetup({
  what,
  services,
  detail,
  actionLabel = 'Open Settings',
  actionRoute = '/settings'
}: {
  what: string
  services: string[]
  detail?: string
  actionLabel?: string
  actionRoute?: string
}) {
  const navigate = useNavigate()
  return (
    <StatusNote action={{ label: actionLabel, onClick: () => navigate(actionRoute) }}>
      {what} requires {joinServices(services)} to be set up.{detail ? ` ${detail}` : ''}
    </StatusNote>
  )
}
