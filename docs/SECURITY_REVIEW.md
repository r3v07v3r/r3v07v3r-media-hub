# Security review playbook

This document supplements code review; a clean result from any single scanner is not proof that the
application is secure. Run the checks against both pull-request source and packaged artifacts.

## Highest-value manual checks

### 1. Renderer compromise to main-process capability

- Inventory every `contextBridge` method and trace it to its `ipcMain` handler.
- Confirm every handler authenticates the top-level sender and validates values at runtime. TypeScript
  types do not validate IPC data.
- Treat paths, URLs, shell arguments, headers, archive contents, and media metadata as hostile.
- Try calls from an iframe, a navigated renderer, DevTools, and malformed direct `ipcRenderer` calls.
- Verify no method provides arbitrary filesystem access, process execution, navigation, or network
  access. Prefer narrow operations such as `{ service: 'jellyfin', path: '/System/Info' }` over a
  generic URL proxy.

### 2. HTTP proxy and SSRF

- Bind requests to a saved service origin in the main process; do not trust a renderer-provided full
  URL or base URL.
- Revalidate every redirect and reject origin changes, URL credentials, non-HTTP protocols, and
  ambiguous/encoded hostnames.
- Decide explicitly whether loopback, link-local, RFC1918, IPv6-local, and DNS names resolving to
  those ranges are allowed for each service. Media servers usually need private addresses, but cloud
  metadata endpoints and unrelated local admin services must remain unreachable.
- Cap request and response bytes, redirect count, header count/size, concurrency, and duration.
- Ensure errors returned to the renderer do not expose credentials, cookies, internal paths, or
  complete upstream response bodies.

### 3. Secrets and authentication

- Store API tokens and passwords with Electron `safeStorage` or an OS keychain rather than plaintext
  JSON. Never put secrets in URLs, logs, telemetry, crash reports, screenshots, or update metadata.
- Redact authorization headers, query tokens, cookies, invite keys, and playback URLs in every logger.
- Test logout/disconnect for memory, database, keychain, and filesystem cleanup.
- Rate-limit Watch Party room creation, connections, and messages; cap message size and connections
  per room. Test host-token theft, host impersonation, replay, room enumeration, and reconnect races.

### 4. Packaged Electron application

- Inspect the effective `BrowserWindow` options at runtime: sandbox on, context isolation on, Node
  integration off, web security on, and remote module unavailable.
- Attempt top-level navigation, popup creation, permission requests, downloads, custom-protocol path
  traversal, and iframe IPC from a packaged build—not only the Vite development server.
- Extract `app.asar` and confirm source maps, `.env` files, signing material, test credentials,
  unnecessary binaries, and development tooling are absent.
- Code-sign all release formats, notarize macOS releases, and verify the updater rejects a modified
  manifest or package. Protect release and signing workflows with least-privilege tokens and
  environment approvals.

### 5. Media processing and local services

- Fuzz subtitle, playlist, torrent, magnet, filename, metadata, and malformed media inputs.
- Keep FFmpeg and native modules current; execute FFmpeg without a shell and pass each argument as a
  separate array element. Apply time, output-size, and process-count limits.
- Confirm playback servers bind only to loopback, use unguessable per-session authorization, reject
  unexpected methods/ranges, and shut down after playback.
- Test symlinks, junctions, UNC paths, alternate data streams, reserved device names, and traversal
  on every supported operating system.

## Automated checks to add to CI

| Check                      | Suggested command or service                                               | What it catches                                                                     |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Dependency advisories      | `npm audit --omit=dev` and `osv-scanner scan source -r .`                  | Known vulnerable direct and transitive packages                                     |
| Lockfile/install integrity | `npm ci --ignore-scripts` in an isolated job                               | Lock drift and unexpected install behavior; run required native rebuilds separately |
| Static analysis            | GitHub CodeQL for JavaScript/TypeScript                                    | Injection, path, data-flow, and unsafe API patterns                                 |
| Electron configuration     | `npx @doyensec/electronegativity -i out -o security-electronegativity.csv` | Dangerous Electron preferences and APIs in built output                             |
| Secret scanning            | `gitleaks git --redact --no-banner`                                        | Committed tokens, credentials, and private keys                                     |
| Semgrep                    | `semgrep scan --config p/javascript --config p/typescript --error`         | Broad security patterns and project-specific rules                                  |
| SBOM                       | `npx @cyclonedx/cyclonedx-npm --output-file bom.json`                      | Release component inventory for incident response                                   |
| Artifact malware scan      | Scan installers and bundled FFmpeg in the release job                      | Tampered or unexpected packaged binaries                                            |
| Fuzz/property tests        | `fast-check` tests for URL/path/payload validators                         | Encoding, boundary, and parser inconsistencies                                      |

Pin CI actions and security tools to reviewed versions or immutable commit digests. Upload reports as
artifacts, fail only on an agreed severity threshold, and create a documented exception with owner and
expiry for every suppressed result.

## Regression tests worth implementing first

1. A table-driven IPC test asserting that every registered channel rejects a non-main frame and an
   unexpected origin.
2. Proxy tests for redirect-to-loopback, IPv4/IPv6 variants, credentials, huge bodies/responses,
   timeout boundaries, invalid headers, and DNS rebinding behavior.
3. Custom-protocol tests for encoded traversal, mixed separators, sibling-prefix directories,
   symlinks, malformed percent encoding, and platform-specific paths.
4. Settings tests for missing and extra keys, prototype-pollution keys, oversized strings, invalid
   URLs, and corrupted on-disk JSON.
5. Watch Party tests for oversized messages, connection floods, guest host-token attempts, replayed
   encrypted messages, expiration, and host disconnect/reconnect races.
6. Packaged smoke tests proving sandboxing, navigation blocking, popup denial, permission denial, CSP,
   and preload availability on Windows, macOS, and Linux.

## Review cadence

- Run type checking, lint, unit/integration tests, secret scanning, CodeQL, and dependency checks on
  every pull request.
- Run packaged Electron analysis, SBOM generation, signature verification, and artifact scanning for
  every release candidate.
- Perform a manual threat-model review when adding an IPC method, service integration, protocol,
  updater change, native binary, authentication flow, or externally reachable listener.
- Reassess dependencies and abuse controls monthly and commission an independent penetration test
  before a broadly distributed stable release.
