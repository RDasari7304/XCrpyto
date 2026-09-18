/// <reference types="vite/client" />

// Fallback declaration in case vite/client types don't resolve during the
// Docker build's `tsc -b` step. This is what import.meta.env needs.
interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
