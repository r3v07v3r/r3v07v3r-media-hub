import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Standalone browser-preview build — NOT part of the real Electron app
// (that's electron.vite.config.ts). This produces one self-contained HTML
// file (JS/CSS/fonts inlined) so the dashboard can be opened directly in a
// browser/iframe for a click-around preview, with no Electron main
// process behind it. Every window.api call in the app already checks
// `window.api?.x` first and degrades gracefully (system gauges sit at 0%,
// Settings/Downloads show their "not connected" states) since window.api
// only exists when a preload script actually ran.
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve('preview-dist'),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000
  }
})
