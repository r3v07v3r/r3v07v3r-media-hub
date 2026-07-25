import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Return types are already fully inferred and checked by `npm run
      // typecheck` (strict tsc) — requiring them written out explicitly on
      // every function/component is a style preference this codebase
      // (much of it ported from a prior Next.js build) doesn't follow, and
      // enforcing it retroactively would mean annotating ~100 functions
      // for no type-safety gain.
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // Plain-JS, run-with-node build/tooling scripts (TMDB art fetcher,
    // preview post-processor) — never type-checked by tsc the way the
    // app source is, so the same "already checked elsewhere" rationale
    // above doesn't apply, but requiring hand-written return-type
    // annotations on ad-hoc utility scripts is equally not worth it.
    //
    // The .ai/ review-loop scripts (scripts/ai-*.ts) get the same
    // treatment even though they're TypeScript — they're run directly
    // via tsx (no tsc build step in the loop) and are standalone CLI
    // tooling, not app source.
    files: ['scripts/**/*.mjs', 'scripts/ai-*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
