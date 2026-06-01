import { vi, describe, it, expect, beforeEach } from "vitest"

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
	mockInitI18n
} = vi.hoisted(() => {
	const mockAuth = {
		isAuthed: vi.fn(),
		setSdkClients: vi.fn()
	}

	const mockCache = {
		rootUuid: null as string | null,
		restore: vi.fn()
	}

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
		mockInitI18n: vi.fn()
	}
})

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))
vi.mock("@/lib/secureStore", () => ({ default: mockSecureStore }))
vi.mock("@/lib/auth", () => ({ default: mockAuth }))
vi.mock("@/lib/cache", () => ({ default: mockCache }))
vi.mock("@/queries/client", () => ({ restoreQueries: mockRestoreQueries }))
vi.mock("@/lib/sqlite", () => ({ default: mockSqlite }))
vi.mock("@/lib/offline", () => ({ default: mockOffline }))
vi.mock("@/lib/alerts", () => ({ default: mockAlerts }))
vi.mock("@/lib/foregroundService", () => ({ default: mockForegroundService }))
vi.mock("@/lib/tmp", () => ({ sweepTmpDir: mockSweepTmpDir }))
vi.mock("@/lib/fsUtils", () => ({ sweepStrayDownloadFiles: mockSweepStrayDownloadFiles }))
vi.mock("@/lib/reconnect", () => ({ startReconnectListener: mockStartReconnectListener }))
vi.mock("@/lib/fileCache", () => ({ default: mockFileCache }))
vi.mock("@/lib/audioCache", () => ({ default: mockAudioCache }))
vi.mock("@/lib/i18n", () => ({ initI18n: mockInitI18n }))

import setup from "@/lib/setup"

const STRINGIFIED_CLIENT = { rootUuid: "root-uuid-1" } as any

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

	it("calls sweepTmpDir and sweepStrayDownloadFiles on foreground setup", async () => {
		await setup.setup()

		expect(mockSweepTmpDir).toHaveBeenCalledOnce()
		expect(mockSweepStrayDownloadFiles).toHaveBeenCalledOnce()
	})

	it("skips sweepTmpDir and sweepStrayDownloadFiles in background mode", async () => {
		await setup.setup({ background: true })

		expect(mockSweepTmpDir).not.toHaveBeenCalled()
		expect(mockSweepStrayDownloadFiles).not.toHaveBeenCalled()
	})

	it("skips offline.updateIndex and offline.sync in background mode", async () => {
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: true, stringifiedClient: STRINGIFIED_CLIENT })

		await setup.setup({ background: true })

		expect(mockOffline.updateIndex).not.toHaveBeenCalled()
		expect(mockOffline.sync).not.toHaveBeenCalled()
	})

	it("initialises secureStore, sqlite, cache, and queries unconditionally", async () => {
		await setup.setup()

		expect(mockSecureStore.init).toHaveBeenCalledOnce()
		expect(mockSqlite.init).toHaveBeenCalledOnce()
		expect(mockCache.restore).toHaveBeenCalledOnce()
		expect(mockRestoreQueries).toHaveBeenCalledOnce()
	})

	it("throws when the inner run callback rejects", async () => {
		const boom = new Error("sqlite exploded")
		mockSqlite.init.mockRejectedValue(boom)

		await expect(setup.setup()).rejects.toThrow("sqlite exploded")
	})
})
