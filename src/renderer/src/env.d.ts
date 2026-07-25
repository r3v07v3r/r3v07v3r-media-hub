/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARTWORK_PROVIDER?: string
  readonly VITE_TMDB_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
