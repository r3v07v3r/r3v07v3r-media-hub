// Ported from r3v07v3r-media-hub's src/upnp.cjs. Best-effort UPnP port
// mapping for Watch Party's direct/LAN mode — the double try/catch is
// intentional and preserved exactly: ANY failure (missing/broken
// dependency, no gateway found, mapping rejected, no external IP) falls
// silently back to `null` so callers degrade to relay mode instead of
// throwing.

export interface PortMappingResult {
  ip: string
  port: number
  stop: () => void
}

export async function attemptPortMapping(
  localPort: number,
  localHost: string,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {}
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
