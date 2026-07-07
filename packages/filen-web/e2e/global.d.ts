// Types the VITE_E2E test hooks the app installs on `window` (src/e2e-hooks/index.ts) for use inside
// Playwright page.evaluate callbacks. Kept as a standalone, minimal mirror because the e2e project
// cannot import the browser module directly — it pulls in Vite-only `?worker` imports that tsc can't
// resolve. Declared non-optional: every spec waits for the hooks before touching them.
interface E2eHooks {
	mint: (email: string, password: string) => Promise<string>
	dumpSession: () => Promise<string>
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	kvHas: (key: string) => Promise<boolean>
	setUserCombo: (actionId: string, combo: string) => Promise<void>
	comboFor: (actionId: string) => string
}

declare global {
	interface Window {
		__filenE2E: E2eHooks
	}
}

export {}
