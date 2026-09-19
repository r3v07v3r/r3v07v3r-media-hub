import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { fontPackageRoot } from './vite.fonts'

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
