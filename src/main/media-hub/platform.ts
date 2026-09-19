// What THIS build of the service layer can do that not every host can.
//
// The service layer now runs in more than one place: inside the Electron
// desktop app, and headless behind a bridge (src/headless/) as the backend of
// the TV and phone apps. Most of it neither knows nor cares. A few subsystems
// reach for something only a desktop has — a worker thread polling WMI, a
// window to embed a video in, an installer to swap itself for — and each of
// those asks here first.
//
// A capability names something the HOST provides, never a platform:
// `process.platform` cannot say "Android" (it says linux), and a check like
// that would be wrong again the day a second headless host appears. Everything
// defaults to true, because the desktop app is the host that has everything
// and must not have to say so; a lesser host states what it lacks, once, before
// the service layer starts (see src/headless/main.ts).
//
// Deliberately small. A capability is added when a subsystem is actually gated
// on it, not in anticipation — an entry nothing reads is a lie waiting to
// happen.

export interface PlatformCapabilities {
  /** Host CPU / GPU / memory / network gauges, sampled on a worker thread
   *  (ipc/telemetry.ts). Off where there is no such worker to run, and where
   *  the numbers would describe a TV box nobody asked about. */
  systemTelemetry: boolean
}

const capabilities: PlatformCapabilities = {
  systemTelemetry: true
}

/** Host-facing, and only before the service layer starts: several subsystems
 *  decide what to be the first time they are touched. */
export function setPlatformCapabilities(overrides: Partial<PlatformCapabilities>): void {
  Object.assign(capabilities, overrides)
}

export function platformCapabilities(): Readonly<PlatformCapabilities> {
  return capabilities
}
