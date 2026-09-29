import { vi } from "vitest"

// Defaults every file would otherwise repeat; a test file's own vi.mock / vi.stubGlobal overrides them.
// The real client spawns a Vite `?worker`, which does not resolve under vitest.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), dump: () => [] } }))

// jsdom has no ResizeObserver; an inert one lets components that merely observe mount.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe = vi.fn()
		unobserve = vi.fn()
		disconnect = vi.fn()
	}
}
