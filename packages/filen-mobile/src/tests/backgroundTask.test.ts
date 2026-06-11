import { describe, it, expect, beforeEach, vi } from "vitest"

// ─── Hoisted mock state ───────────────────────────────────────────────────────
// vi.mock factories are hoisted to the top of the file by Vitest, so any variable
// they reference must be created via vi.hoisted (which also runs before vi.mock).
const { mockTaskManager, mockBackgroundTask, mockRemoveListener, mockSetup, mockCameraUpload, capturedTaskCallback } = vi.hoisted(() => {
	const mockRemoveListener = vi.fn()
	const capturedTaskCallback: { fn: ((data: unknown) => Promise<unknown>) | null } = { fn: null }

	const mockTaskManager = {
		defineTask: vi.fn((_name: string, fn: (data: unknown) => Promise<unknown>) => {
			capturedTaskCallback.fn = fn
		}),
		isTaskRegisteredAsync: vi.fn().mockResolvedValue(false)
	}

	const mockBackgroundTask = {
		BackgroundTaskStatus: { Restricted: 1, Available: 2 },
		BackgroundTaskResult: { Success: 1, Failed: 2 },
		getStatusAsync: vi.fn().mockResolvedValue(2),
		registerTaskAsync: vi.fn().mockResolvedValue(undefined),
		unregisterTaskAsync: vi.fn().mockResolvedValue(undefined),
		addExpirationListener: vi.fn().mockReturnValue({ remove: mockRemoveListener })
	}

	const mockSetup = { setup: vi.fn().mockResolvedValue({ isAuthed: false }) }

	const mockCameraUpload = { cancel: vi.fn(), sync: vi.fn().mockResolvedValue(undefined) }

	return { mockTaskManager, mockBackgroundTask, mockRemoveListener, mockSetup, mockCameraUpload, capturedTaskCallback }
})

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("expo-task-manager", () => mockTaskManager)

vi.mock("expo-background-task", () => mockBackgroundTask)

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/setup", () => ({ default: mockSetup }))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: mockCameraUpload }))

// backgroundTask.ts gained the budgeted offline phase (2026-06-11): mock its three new
// imports so this suite's import graph stays cut at the same boundary as before. The
// offline branch's behavior is pinned in backgroundTaskHardening.test.ts — these mocks
// only keep the module loadable; the default (setting absent → null) keeps every
// existing assertion's flow identical (offline phase skipped).
vi.mock("@/features/offline/offlineSync", () => ({
	default: {
		sync: vi.fn(async () => undefined),
		cancel: vi.fn()
	}
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: vi.fn(async () => null)
	}
}))

vi.mock("@/features/offline/offlineHelpers", () => ({
	OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY: "offlineBackgroundSync"
}))

// The fact-check pass (2026-06-11) added the persist-before-suspend flush defer, so the
// module now imports the two persisters. Same boundary-cut rationale as above: resolved
// no-op flushes keep every existing assertion's flow identical, and the flush behavior
// itself is pinned in backgroundTaskHardening.test.ts.
vi.mock("@/lib/cache", () => ({
	default: {
		flushNow: vi.fn(async () => undefined)
	}
}))

vi.mock("@/queries/client", () => ({
	queryClientPersisterKv: {
		flushNow: vi.fn(async () => undefined)
	}
}))

vi.mock("@/features/cameraUpload/backgroundRunLog", () => ({
	default: {
		append: vi.fn(async () => undefined)
	}
}))

// ─── Static import of module under test ──────────────────────────────────────
// Must be a static import so the module-level defineTask call is intercepted by
// mockTaskManager.defineTask, which captures the callback into capturedTaskCallback.
import { registerBackgroundSync, unregisterBackgroundSync } from "@/features/cameraUpload/backgroundTask"
import { Platform } from "react-native"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Simulate the OS invoking the background task by calling the captured defineTask callback. */
async function runTask(): Promise<unknown> {
	if (!capturedTaskCallback.fn) {
		throw new Error("TaskManager.defineTask callback was never captured — did the module load?")
	}
	return capturedTaskCallback.fn({})
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks()
	// Restore default return values cleared by clearAllMocks
	mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Available)
	mockBackgroundTask.registerTaskAsync.mockResolvedValue(undefined)
	mockBackgroundTask.unregisterTaskAsync.mockResolvedValue(undefined)
	mockBackgroundTask.addExpirationListener.mockReturnValue({ remove: mockRemoveListener })
	mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false)
	mockSetup.setup.mockResolvedValue({ isAuthed: false })
	mockCameraUpload.sync.mockResolvedValue(undefined)
	;(Platform as { OS: string }).OS = "ios"
})

// ─── registerBackgroundSync ───────────────────────────────────────────────────

describe("registerBackgroundSync", () => {
	it("registers the task when status equals BackgroundTaskStatus.Available", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Available)

		await registerBackgroundSync()

		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync", { minimumInterval: 15 })
	})

	it("skips registration when status is Restricted", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Restricted)

		await registerBackgroundSync()

		expect(mockBackgroundTask.registerTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when getStatusAsync rejects, and does not register the task", async () => {
		mockBackgroundTask.getStatusAsync.mockRejectedValue(new Error("unavailable"))

		await expect(registerBackgroundSync()).resolves.toBeUndefined()
		expect(mockBackgroundTask.registerTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when registerTaskAsync rejects, and registerTaskAsync was actually called", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Available)
		mockBackgroundTask.registerTaskAsync.mockRejectedValue(new Error("register failed"))

		await expect(registerBackgroundSync()).resolves.toBeUndefined()
		// Ensures the code reached registerTaskAsync before the rejection — without this
		// assertion the test would pass even if status-check early-returned silently.
		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync", { minimumInterval: 15 })
	})

	it("calls registerTaskAsync on every invocation (no idempotency guard)", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Available)

		await registerBackgroundSync()
		await registerBackgroundSync()

		// registerBackgroundSync has no isTaskRegisteredAsync guard, so both calls
		// reach registerTaskAsync — this documents and verifies that behavior.
		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledTimes(2)
	})
})

// ─── unregisterBackgroundSync ─────────────────────────────────────────────────

describe("unregisterBackgroundSync", () => {
	it("unregisters the task when it is registered", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true)

		await unregisterBackgroundSync()

		expect(mockBackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync")
	})

	it("skips unregistration when the task is not registered", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false)

		await unregisterBackgroundSync()

		expect(mockBackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when isTaskRegisteredAsync rejects, and does not unregister", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockRejectedValue(new Error("query failed"))

		await expect(unregisterBackgroundSync()).resolves.toBeUndefined()
		expect(mockBackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when unregisterTaskAsync rejects", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true)
		mockBackgroundTask.unregisterTaskAsync.mockRejectedValue(new Error("unregister failed"))

		await expect(unregisterBackgroundSync()).resolves.toBeUndefined()
	})
})

// ─── TaskManager.defineTask callback ─────────────────────────────────────────

describe("background task callback (defineTask body)", () => {
	it("is registered for the correct task name at module load time", () => {
		// defineTask is called at module-level, before tests run; clearAllMocks() in beforeEach
		// resets call history, so we verify the side-effect (captured callback) instead.
		expect(capturedTaskCallback.fn).not.toBeNull()
		expect(typeof capturedTaskCallback.fn).toBe("function")
	})

	it("returns BackgroundTaskResult.Success after an authenticated run", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Success)
	})

	it("returns BackgroundTaskResult.Success even when not authed (unconditional return)", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Success)
	})

	it("calls setup.setup with {background:true} regardless of auth state", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		await runTask()

		expect(mockSetup.setup).toHaveBeenCalledWith({ background: true })
	})

	it("does NOT call cameraUpload.sync when setup reports isAuthed: false", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		await runTask()

		expect(mockCameraUpload.sync).not.toHaveBeenCalled()
	})

	it("calls cameraUpload.sync with {maxUploads:1, background:true} when authed", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })

		await runTask()

		expect(mockCameraUpload.sync).toHaveBeenCalledWith({ maxUploads: 1, background: true })
		expect(mockCameraUpload.sync).toHaveBeenCalledTimes(1)
	})

	describe("iOS expiration listener (Platform.OS === 'ios')", () => {
		it("registers an expiration listener on iOS", async () => {
			;(Platform as { OS: string }).OS = "ios"
			mockSetup.setup.mockResolvedValue({ isAuthed: false })

			await runTask()

			expect(mockBackgroundTask.addExpirationListener).toHaveBeenCalledTimes(1)
			expect(mockBackgroundTask.addExpirationListener).toHaveBeenCalledWith(expect.any(Function))
		})

		it("calls cameraUpload.cancel when the expiration listener fires on iOS", async () => {
			;(Platform as { OS: string }).OS = "ios"
			mockSetup.setup.mockResolvedValue({ isAuthed: false })

			let expirationCallback: (() => void) | null = null
			mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
				expirationCallback = cb
				return { remove: mockRemoveListener }
			})

			await runTask()

			expect(expirationCallback).not.toBeNull()
			expirationCallback!()
			expect(mockCameraUpload.cancel).toHaveBeenCalledTimes(1)
		})

		it("removes the expiration listener via defer after the task body completes on iOS", async () => {
			;(Platform as { OS: string }).OS = "ios"
			mockSetup.setup.mockResolvedValue({ isAuthed: false })

			await runTask()

			// The run() utility calls deferred cleanups after the body resolves
			expect(mockRemoveListener).toHaveBeenCalledTimes(1)
		})

		it("does NOT register an expiration listener on Android", async () => {
			;(Platform as { OS: string }).OS = "android"
			mockSetup.setup.mockResolvedValue({ isAuthed: false })

			await runTask()

			expect(mockBackgroundTask.addExpirationListener).not.toHaveBeenCalled()
		})

		it("does NOT call cameraUpload.cancel or remove the listener on Android", async () => {
			;(Platform as { OS: string }).OS = "android"
			mockSetup.setup.mockResolvedValue({ isAuthed: true })

			await runTask()

			expect(mockCameraUpload.cancel).not.toHaveBeenCalled()
			expect(mockRemoveListener).not.toHaveBeenCalled()
		})
	})
})
