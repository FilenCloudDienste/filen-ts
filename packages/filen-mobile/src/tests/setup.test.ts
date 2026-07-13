import { vi, describe, it, expect, beforeEach } from "vitest"

// setup.ts now imports expo-image (for the iOS disk-cache cap) — unloadable in the node
// env, which needs the native expo runtime. Mock it.
vi.mock("expo-image", async () => await import("@/tests/mocks/expoImage"))

const {
	mockAuth,
	mockCache,
	mockSecureStore,
	mockSqlite,
	mockRestoreQueries,
	mockStartReconnectListener,
	mockSweepTmpDir,
	mockSweepStrayDownloadFiles,
	mockForegroundService,
	mockOffline,
	mockAlerts,
	mockFileCache,
	mockAudioCache,
	mockInitI18n,
	mockInitTheme,
	mockSemaphoreRelease
} = vi.hoisted(() => {
	const mockAuth = {
		isAuthed: vi.fn(),
		setSdkClients: vi.fn(),
		loadTransferConfig: vi.fn()
	}

	const mockCache = {
		rootUuid: null as string | null,
		restore: vi.fn()
	}

	const mockSemaphoreRelease = vi.fn()

	return {
		mockAuth,
		mockCache,
		mockSecureStore: { init: vi.fn() },
		mockSqlite: { init: vi.fn() },
		mockRestoreQueries: vi.fn(),
		mockStartReconnectListener: vi.fn(),
		mockSweepTmpDir: vi.fn(),
		mockSweepStrayDownloadFiles: vi.fn(),
		mockForegroundService: { init: vi.fn() },
		mockOffline: { updateIndex: vi.fn(), sync: vi.fn() },
		mockAlerts: { error: vi.fn() },
		mockFileCache: { gc: vi.fn() },
		mockAudioCache: { gc: vi.fn() },
		mockInitI18n: vi.fn(),
		mockInitTheme: vi.fn(),
		mockSemaphoreRelease
	}
})

// Inline LIFO-correct run() mock that matches real @filen/utils behavior:
// cleanups run in reverse registration order (LIFO) inside a finally block,
// each individually try/caught. This is more faithful than the shared
// filenUtils mock which iterates forward and only on success/catch.
vi.mock("@filen/utils", () => {
	class Semaphore {
		async acquire(): Promise<void> {}
		release(): void {
			mockSemaphoreRelease()
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>): Promise<any> {
		const cleanups: (() => void)[] = []
		const defer = (cleanup: () => void) => {
			cleanups.push(cleanup)
		}
		try {
			const data = await fn(defer)
			return { success: true, data, error: null }
		} catch (error) {
			return { success: false, data: null, error }
		} finally {
			for (let i = cleanups.length - 1; i >= 0; i--) {
				try {
					cleanups[i]?.()
				} catch {}
			}
		}
	}

	return { Semaphore, run, default: run, createExecutableTimeout: vi.fn() }
})
vi.mock("@/lib/secureStore", () => ({ default: mockSecureStore }))
vi.mock("@/lib/auth", () => ({ default: mockAuth }))
vi.mock("@/lib/cache", () => ({ default: mockCache }))
vi.mock("@/queries/client", () => ({ restoreQueries: mockRestoreQueries }))
vi.mock("@/lib/sqlite", () => ({ default: mockSqlite }))
vi.mock("@/features/offline/offline", () => ({ default: mockOffline }))
vi.mock("@/lib/alerts", () => ({ default: mockAlerts }))
vi.mock("@/features/transfers/foregroundService", () => ({ default: mockForegroundService }))
// fileProvider pulls in native modules (expo-secure-store, the Android Keystore module) via authFileKey;
// setup() only fire-and-forgets ensureEncrypted(), so a thin stub is enough.
vi.mock("@/features/settings/fileProvider", () => ({ default: { ensureEncrypted: vi.fn(async () => {}) } }))
vi.mock("@/features/drive/driveSearch", () => ({
	default: { init: vi.fn(async () => {}), closeActive: vi.fn(async () => {}), teardownOnLogout: vi.fn(async () => {}) }
}))
vi.mock("@/lib/tmp", () => ({ sweepTmpDir: mockSweepTmpDir }))
vi.mock("@/lib/fsUtils", () => ({ sweepStrayDownloadFiles: mockSweepStrayDownloadFiles }))
vi.mock("@/lib/reconnect", () => ({ startReconnectListener: mockStartReconnectListener }))
vi.mock("@/lib/fileCache", () => ({ default: mockFileCache }))
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/audio/audioCache", () => ({ default: mockAudioCache }))
vi.mock("@/lib/i18n", () => ({ initI18n: mockInitI18n }))
vi.mock("@/lib/theme", () => ({ initTheme: mockInitTheme }))

import setup from "@/lib/setup"

const STRINGIFIED_CLIENT = { rootUuid: "root-uuid-1" } as any

// Flush all pending microtasks so fire-and-forget promise chains settle.
// A single Promise.resolve() tick is enough because the chains are depth-1
// (.catch() on a resolved promise).
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.clearAllMocks()
	mockCache.rootUuid = null
	mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })
	mockAuth.setSdkClients.mockResolvedValue(undefined)
	mockSecureStore.init.mockResolvedValue(undefined)
	mockSqlite.init.mockResolvedValue(undefined)
	mockCache.restore.mockResolvedValue(undefined)
	mockRestoreQueries.mockResolvedValue(undefined)
	mockForegroundService.init.mockResolvedValue(undefined)
	mockOffline.updateIndex.mockResolvedValue(undefined)
	mockOffline.sync.mockResolvedValue(undefined)
	mockFileCache.gc.mockResolvedValue(undefined)
	mockAudioCache.gc.mockResolvedValue(undefined)
	mockInitI18n.mockResolvedValue(undefined)
	mockInitTheme.mockResolvedValue(undefined)
})

describe("setup.setup", () => {
	it("returns { isAuthed: false } when not authenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })

		const result = await setup.setup()

		expect(result).toEqual({ isAuthed: false })
		expect(mockAuth.setSdkClients).not.toHaveBeenCalled()
	})

	it("returns { isAuthed: true } and initialises SDK clients when authenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		const result = await setup.setup()

		expect(result).toEqual({ isAuthed: true })
		expect(mockAuth.setSdkClients).toHaveBeenCalledWith(STRINGIFIED_CLIENT)
	})

	it("sets cache.rootUuid from the stringified client when authenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup()

		expect(mockCache.rootUuid).toBe("root-uuid-1")
	})

	it("always calls startReconnectListener regardless of auth state", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })

		await setup.setup()

		expect(mockStartReconnectListener).toHaveBeenCalledOnce()
	})

	// The crash-orphan sweeps were removed from boot entirely — the stray-file walk
	// scales with the offline store (~1.9s measured). They live behind the Settings →
	// Advanced "Clean up temporary files" action now.
	it("never calls sweepTmpDir or sweepStrayDownloadFiles during setup", async () => {
		await setup.setup()
		await setup.setup({ background: true })

		expect(mockSweepTmpDir).not.toHaveBeenCalled()
		expect(mockSweepStrayDownloadFiles).not.toHaveBeenCalled()
	})

	it("initialises secureStore, sqlite, queries, i18n, and theme unconditionally", async () => {
		await setup.setup()

		expect(mockSecureStore.init).toHaveBeenCalledOnce()
		expect(mockSqlite.init).toHaveBeenCalledOnce()
		expect(mockRestoreQueries).toHaveBeenCalledOnce()
		expect(mockInitI18n).toHaveBeenCalledOnce()
		expect(mockInitTheme).toHaveBeenCalledOnce()
	})

	// #1 — cache.restore() is gated on auth: the persistent caches hold decrypted-at-rest metadata,
	// so they must not be hydrated while logged out (that would re-surface a prior account's data and
	// defeat the logout wipe).
	it("restores the cache when authenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup()

		expect(mockCache.restore).toHaveBeenCalledOnce()
	})

	it("does NOT restore the cache when unauthenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })

		await setup.setup()

		expect(mockCache.restore).not.toHaveBeenCalled()
	})

	it("throws when the inner run callback rejects", async () => {
		const boom = new Error("sqlite exploded")
		mockSqlite.init.mockRejectedValue(boom)

		await expect(setup.setup()).rejects.toThrow("sqlite exploded")
	})

	// #184 — verify that the deferred mutex release fires unconditionally (in the
	// finally block of run()), so the Semaphore is always returned even when the
	// inner callback throws. Uses the inline LIFO-correct mock above.
	it("releases the setup mutex (deferred cleanup) even when the inner callback rejects", async () => {
		const boom = new Error("init failed")
		mockSecureStore.init.mockRejectedValue(boom)

		await expect(setup.setup()).rejects.toThrow("init failed")

		expect(mockSemaphoreRelease).toHaveBeenCalledOnce()
	})

	it("releases the setup mutex (deferred cleanup) on a successful run", async () => {
		await setup.setup()

		expect(mockSemaphoreRelease).toHaveBeenCalledOnce()
	})

	it("calls foregroundService.init when isAuthed and not background", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup()
		await flushMicrotasks()

		expect(mockForegroundService.init).toHaveBeenCalledOnce()
	})

	it("does not call foregroundService.init when isAuthed is false (foreground)", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })

		await setup.setup()
		await flushMicrotasks()

		expect(mockForegroundService.init).not.toHaveBeenCalled()
	})

	it("skips foregroundService.init in background mode even when authenticated", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup({ background: true })
		await flushMicrotasks()

		expect(mockForegroundService.init).not.toHaveBeenCalled()
	})

	// Boot-time gc was removed: fileCache/audioCache schedule their own gc after
	// writes and on app-background instead of competing with startup.
	it("never calls fileCache.gc or audioCache.gc during setup", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup()
		await flushMicrotasks()

		expect(mockFileCache.gc).not.toHaveBeenCalled()
		expect(mockAudioCache.gc).not.toHaveBeenCalled()
	})
})
