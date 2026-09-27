import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fontPackageRoot } from './vite.fonts'

// The phone/TV app: a small, separate React tree (src/app-ui, not
// src/renderer) built the same way vite.web.config.ts builds the desktop
// renderer for the web — a static site that installs window.api over the
// bridge when one is present (see src/app-ui/main.tsx). Its own config
// rather than a second entry inside vite.web.config.ts because the two
// share no components and have very different size budgets: this one has
// to stay small enough to be comfortable on a phone or a TV box, where the
// desktop renderer's animated, panel-heavy UI would not be.
export default defineConfig({
  root: resolve('src/app-ui'),
  // Relative, like vite.web.config.ts — the output has to work from
  // whatever mounts it (a static server today, a phone/TV asset loader
  // later), not just from a domain root.
  base: './',
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  server: {
    fs: {
      // See vite.web.config.ts / electron.vite.config.ts: from a git
      // worktree the webfonts resolve into the main checkout's
      // node_modules, outside this project root. This app bundles no
      // fonts of its own today, but keeping the allow-list identical to
      // the other renderer build avoids a config that quietly drifts.
      allow: [resolve('.'), fontPackageRoot()]
    }
  },
  plugins: [react()],
  build: {
    outDir: resolve('dist-app'),
    emptyOutDir: true
  }
})
