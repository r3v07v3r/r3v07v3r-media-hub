import { dirname, resolve } from 'path'
import { createRequire } from 'module'

/**
 * The node_modules directory the bundled webfonts actually resolved from.
 *
 * Node finds packages by walking UP from the importer, so this is the
 * project's own node_modules in an ordinary checkout and the MAIN
 * checkout's when running from a git worktree (which has none of its own).
 * Vite's dev server needs it on the fs.allow list either way, and asking
 * Node where the package really is beats guessing at a relative depth.
 *
 * Falls back to the project root if the package cannot be resolved at all —
 * a missing dependency should surface as a missing dependency, not as a
 * config crash before the dev server ever starts.
 *
 * Shared by every config that serves the renderer (electron.vite.config.ts,
 * vite.web.config.ts) so the two cannot drift.
 */
export function fontPackageRoot(): string {
  try {
    const require = createRequire(import.meta.url)
    // .../node_modules/@fontsource/inter -> .../node_modules, so the sibling
    // font packages (orbitron, rajdhani) are covered by the same entry
    // rather than needing one each.
    return dirname(dirname(dirname(require.resolve('@fontsource/inter/package.json'))))
  } catch {
    return resolve('.')
  }
}
