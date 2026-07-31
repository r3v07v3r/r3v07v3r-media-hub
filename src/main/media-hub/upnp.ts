// Ported from r3v07v3r-media-hub's src/upnp.cjs. Best-effort automatic
// router port mapping for Watch Party's direct/LAN mode — the double
// try/catch is intentional and preserved exactly: ANY failure (missing/
// broken dependency, no gateway found, mapping rejected, no external IP)
// falls silently back to `null` so callers degrade to relay mode instead of
// throwing.
//
// Tries UPnP-IGD first, then falls back to NAT-PMP if UPnP finds no
// working gateway — both are genuinely supported by @achingbrain/
// nat-port-mapper (confirmed against its own source/README: `upnpNat()` for
// the former, `pmpNat(gatewayIp)` for the latter, both returning the same
// `Gateway` interface). These are different protocols many consumer
// routers implement inconsistently — some (older Apple/some ISP-supplied
// gear) support NAT-PMP even with UPnP turned off, and vice versa — so
// trying both roughly doubles the real-world chance of automatic WAN
// reachability working at all, at the cost of one extra gateway-IP lookup
// when UPnP alone doesn't pan out. Neither this library nor its NAT-PMP
// path support PCP (Port Control Protocol, NAT-PMP's newer successor) —
// that would need a different dependency entirely if ever added.

export interface PortMappingResult {
  ip: string
  port: number
  stop: () => void
}

async function tryUpnp(
  localPort: number,
  localHost: string,
  timeoutMs: number
): Promise<PortMappingResult | null> {
  try {
    const { upnpNat } = await import('@achingbrain/nat-port-mapper')
    const client = upnpNat()
    for await (const gateway of client.findGateways({ signal: AbortSignal.timeout(timeoutMs) })) {
      try {
        const mapping = await gateway.map(localPort, localHost, { protocol: 'tcp' })
        const externalIp = await gateway.externalIp()
        if (!externalIp) continue
        return {
          ip: externalIp,
          port: Number(mapping?.externalPort) || localPort,
          stop: () => {
            gateway.stop().catch(() => {})
          }
        }
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

async function tryNatPmp(
  localPort: number,
  localHost: string,
  timeoutMs: number
): Promise<PortMappingResult | null> {
  try {
    const [{ pmpNat }, { gateway4async }] = await Promise.all([
      import('@achingbrain/nat-port-mapper'),
      import('default-gateway')
    ])
    const { gateway: gatewayIp } = await gateway4async()
    if (!gatewayIp) return null
    const gateway = pmpNat(gatewayIp)
    try {
      // NAT-PMP is UDP request/response with no inherent retry-then-fail
      // behavior of its own — confirmed live that a router which simply
      // doesn't speak NAT-PMP (the overwhelmingly common case when UPnP
      // already failed) silently drops the request instead of rejecting
      // it, and neither `map()` nor `externalIp()` time out on their own
      // without an explicit signal — this hung the whole party:host IPC
      // call indefinitely before this fix (party state was already set,
      // but the handler's own response — and so the renderer's "Working…"
      // state — never returned at all).
      const mapping = await gateway.map(localPort, localHost, {
        protocol: 'tcp',
        signal: AbortSignal.timeout(timeoutMs)
      })
      const externalIp = await gateway.externalIp({ signal: AbortSignal.timeout(timeoutMs) })
      if (!externalIp) {
        await gateway.stop().catch(() => {})
        return null
      }
      return {
        ip: externalIp,
        port: Number(mapping?.externalPort) || localPort,
        stop: () => {
          gateway.stop().catch(() => {})
        }
      }
    } catch {
      await gateway.stop().catch(() => {})
      return null
    }
  } catch {
    return null
  }
}

export async function attemptPortMapping(
  localPort: number,
  localHost: string,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {}
): Promise<PortMappingResult | null> {
  const viaUpnp = await tryUpnp(localPort, localHost, timeoutMs)
  if (viaUpnp) return viaUpnp
  // Belt-and-suspenders on top of tryNatPmp's own per-call signals: the
  // `default-gateway` package's gateway4async() shells out to an OS command
  // (wmic on Windows) with no abort/timeout option of its own at all, so a
  // hung or misbehaving shell-out here would otherwise have no backstop —
  // this whole function must never block party:host's IPC response
  // indefinitely regardless of which specific step misbehaves.
  return Promise.race([
    tryNatPmp(localPort, localHost, timeoutMs),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs * 2))
  ])
}
