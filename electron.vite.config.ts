import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
 */
function fontPackageRoot(): string {
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

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // telemetryWorker runs as its own worker_thread (see
        // src/main/ipc/telemetry.ts) via `new Worker(join(__dirname,
        // 'telemetryWorker.js'))`, which needs a real sibling file next to
        // index.js — not something bundled into the main entry itself.
        input: {
          index: resolve('src/main/index.ts'),
          telemetryWorker: resolve('src/main/media-hub/telemetryWorker.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // `sandbox: true` (see main/index.ts) runs the preload script through
      // Electron's sandboxed loader, which only resolves `electron` itself
      // at runtime (verified live) — a plain `require("@electron-toolkit/
      // preload")` left as an external, as electron-vite defaults every
      // package.json dependency to, throws "module not found" and the
      // whole preload (so window.api) silently never loads. Bundling this
      // one dependency inline instead keeps it self-contained; `electron`
      // stays external since the sandboxed loader provides that one
      // specially.
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    server: {
      fs: {
        // Vite only serves files under the project root, and `npm run dev`
        // from a git worktree (this repo keeps them in .claude/worktrees/)
        // is outside it: the worktree has no node_modules of its own, so
        // Node resolves packages by walking UP to the main checkout's, and
        // every @fontsource file then lands outside the allow list. The app
        // still runs, but Inter/Orbitron/Rajdhani all 403 and it renders in
        // fallback system faces — which looks like a styling regression and
        // is not one.
        //
        // Derived from where the package actually resolved to rather than by
        // walking up a fixed number of levels: `resolve('../../..')` happens
        // to be the main checkout from a worktree, but it is the DRIVE ROOT
        // from an ordinary one, which would let the dev server serve
        // anything on the disk.
        //
        // A no-op in an ordinary checkout, where this already sits under the
        // project root.
        allow: [resolve('.'), fontPackageRoot()]
      }
    },
    plugins: [react()]
  }
})
