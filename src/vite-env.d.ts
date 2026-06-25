/// <reference types="vite/client" />

// Custom build-time env vars (Vite only exposes those prefixed VITE_). Declaring
// VITE_SERVER_URL here lets `tsc --noEmit` typecheck its use in src/main.ts. It's
// optional: unset in dev (the client falls back to the same-origin /ws proxy),
// set in .env.production to the deployed Railway server's wss:// URL.
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
