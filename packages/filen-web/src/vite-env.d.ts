/// <reference types="vite/client" />

interface ImportMetaEnv {
	// "1" only for e2e builds (VITE_E2E=1); absent otherwise. Declaring it as a known key lets
	// main.tsx read `import.meta.env.VITE_E2E` with dot access (which Vite statically replaces /
	// rolldown constant-folds) so the e2e-hooks dynamic import is dead-code-eliminated from a normal
	// build — a computed `["VITE_E2E"]` access is NOT folded and would leak the chunk into prod.
	readonly VITE_E2E?: string
}
