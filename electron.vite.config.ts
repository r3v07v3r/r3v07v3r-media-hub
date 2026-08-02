import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()]
  }
})
