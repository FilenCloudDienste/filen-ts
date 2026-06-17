import { vi } from "vitest"

/**
 * Shared no-op mock of the diagnostic logger (src/lib/logger.ts default export).
 *
 * Any test that loads a real module which imports `@/lib/logger` must mock it — otherwise the real
 * logger pulls storageRoots → expo-file-system → expo-modules-core, which throws `__DEV__ is not
 * defined` in the node test env. Use:
 *
 *   vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
 *
 * (logger.test.ts / console.test.ts deliberately do NOT use this — they exercise the real logger /
 * the console tee and mock at a finer grain.)
 */
const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	log: vi.fn(),
	captureConsole: vi.fn(),
	flushNow: vi.fn(),
	purge: vi.fn(),
	configure: vi.fn(),
	readEntries: vi.fn(() => []),
	listLogFiles: vi.fn(() => [])
}

export default logger
