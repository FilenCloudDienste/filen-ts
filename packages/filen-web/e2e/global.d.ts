// Types the VITE_E2E test hooks the app installs on `window` (src/e2e-hooks/index.ts) for use inside
// Playwright page.evaluate callbacks. Kept as a standalone, minimal mirror because the e2e project
// cannot import the browser module directly — it pulls in Vite-only `?worker` imports that tsc can't
// resolve. Declared non-optional: every spec waits for the hooks before touching them.
//
// rawStringifiedClient/createTestFile/trashTestFile return real SDK records (bigint fields included)
// — safe here because these types are only ever consumed INSIDE a page.evaluate callback (structured
// clone within the browser), never returned across the Playwright<->page bridge itself (JSON-only,
// bigint-unsafe) — so `unknown` is precise enough for this mirror; sw.spec.ts never inspects their
// shape, only forwards them into a postMessage the same way the real page code would.
interface E2eHooks {
	mint: (email: string, password: string) => Promise<string>
	dumpSession: () => Promise<string>
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	kvHas: (key: string) => Promise<boolean>
	setUserCombo: (actionId: string, combo: string) => Promise<void>
	comboFor: (actionId: string) => string
	rawStringifiedClient: () => Promise<unknown>
	createTestFile: (name: string, content: string, parentUuid?: string | null) => Promise<unknown>
	trashTestFile: (file: unknown) => Promise<void>
	deleteTestNoteByUuid: (uuid: string) => Promise<void>
	// Return type is trimmed to the one field notes.spec.ts actually reads (`uuid`) — same "mirror only
	// what a spec needs" rule as rawStringifiedClient/createTestFile's own `unknown` above.
	createTestNoteWithContent: (
		noteType: "text" | "code" | "md" | "rich" | "checklist",
		content: string,
		title: string
	) => Promise<{ uuid: string }>
	readTestNoteContentByUuid: (uuid: string) => Promise<string | null>
	setTestNoteContentByUuid: (uuid: string, content: string) => Promise<void>
	renameTestNoteByUuid: (uuid: string, title: string) => Promise<void>
	readPersistedInflightContent: (uuid: string) => Promise<string | null>
	listTestNoteUuids: () => Promise<string[]>
	sweepTestNotesByTitlePrefix: (prefix: string) => Promise<number>
	sweepTestTagsByNamePrefix: (prefix: string) => Promise<number>
	thumbnailFileStat: (parentUuid: string, name: string) => Promise<{ size: number; lastModified: number } | null>
}

// Mirrors src/types/desktop.d.ts's DesktopBridge for the same reason as E2eHooks above: this project
// can't import the app source tree. No spec here ever exercises a populated bridge (Electron isn't
// part of this suite) — boot.spec.ts only asserts window.desktop stays undefined in a plain browser,
// so the shape only needs to exist for that read to typecheck.
interface DesktopBridge {
	readonly platform: "darwin" | "win32" | "linux"
	minimize(): void
	toggleMaximize(): void
	hide(): void
	close(): void
	onMaximizedChange(cb: (maximized: boolean) => void): () => void
}

declare global {
	interface Window {
		__filenE2E: E2eHooks
		readonly desktop?: DesktopBridge
	}
}

export {}
