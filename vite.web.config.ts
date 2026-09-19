import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fontPackageRoot } from './vite.fonts'

// The renderer built to run OUTSIDE the Electron shell, as an ordinary static
// site: the same React tree, the same index.html and — deliberately — the
// same Content-Security-Policy as the desktop app. This is the build the TV
// and phone apps load, so `npm run build:web` plus tests/webBundle.e2e.ts in
// CI is what keeps "the renderer has no Electron in it" true between now and
// then.
//
// Not to be confused with vite.preview.config.ts, which inlines everything
// into ONE html file for a throwaway click-around preview and has its CSP
// stripped afterwards (scripts/build-preview.mjs) because inlined script
// cannot run under `script-src 'self'`. This build keeps scripts, styles and
// fonts as separate same-origin files precisely so the real CSP holds.
/**
 * index.html is shared with the desktop build and names the desktop entry.
 * Outside Electron there is no preload to have made `window.api` first, so
 * this build enters through web/main.ts, which does that and then loads the
 * ordinary entry. Swapped here rather than by keeping a second html file, so
 * there is exactly one copy of the page — and of its CSP — to keep right.
 */
function webEntry(): Plugin {
  const desktopEntry = '/src/main.tsx'
  return {
    name: 'r3-web-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(desktopEntry)) {
          throw new Error(`index.html no longer loads ${desktopEntry}; update vite.web.config.ts`)
        }
        return html.replace(desktopEntry, '/src/web/main.ts')
      }
    }
  }
}

export default defineConfig({
  root: resolve('src/renderer'),
  // Relative, so the output works from any mount point — a static server's
  // root today, an Android asset loader's path later.
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: {
    fs: {
      // See electron.vite.config.ts: from a git worktree the webfonts resolve
      // into the main checkout's node_modules, outside the project root.
      allow: [resolve('.'), fontPackageRoot()]
    }
  },
  plugins: [react(), webEntry()],
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true
  }
})
