/// <reference types="vite/client" />

interface ImportMetaEnv {
	// "1" only for e2e builds (VITE_E2E=1); absent otherwise. Declaring it as a known key lets
	// main.tsx read `import.meta.env.VITE_E2E` with dot access (which Vite statically replaces /
	// rolldown constant-folds) so the e2e-hooks dynamic import is dead-code-eliminated from a normal
	// build — a computed `["VITE_E2E"]` access is NOT folded and would leak the chunk into prod.
	readonly VITE_E2E?: string
	// The deployed commit, set by the deploy workflows. Reported by the service worker so that every
	// deployed build changes sw.js and reaches open tabs as a worker update; absent in local builds.
	readonly VITE_BUILD_ID?: string
	// The directory the assistant's model files are served from; defaults to the Filen CDN
	// (features/assistant/runtime/manifest.ts). vite.config.ts adds its origin to connect-src.
	readonly VITE_ASSISTANT_MODEL_BASE_URL?: string
}
