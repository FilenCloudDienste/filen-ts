import { describe, it, expect, beforeEach, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

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

// Same boundary-cut rationale for the offline-NOTES phase: notesOffline reaches SQLite and the SDK,
// and a resolved no-op sync keeps every existing assertion's flow identical.
vi.mock("@/features/notes/notesOffline", () => ({
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

// The persist-before-suspend flush defer means the module imports the query persister. Same
// boundary-cut rationale as above: a resolved no-op flush keeps every existing assertion's flow
// identical, and the flush behavior itself is pinned in backgroundTaskHardening.test.ts.
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
import {
	registerBackgroundSync,
	unregisterBackgroundSync,
	BACKGROUND_RUN_BUDGET_MS,
	CAMERA_PHASE_RESERVE_MS
} from "@/features/cameraUpload/backgroundTask"
import { Platform } from "react-native"
import backgroundRunLog from "@/features/cameraUpload/backgroundRunLog"

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
	mockCameraUpload.sync.mockResolvedValue({ success: true })
	;(Platform as { OS: string }).OS = "ios"
})

// ─── registerBackgroundSync ───────────────────────────────────────────────────

describe("registerBackgroundSync", () => {
	it("registers the task when status equals BackgroundTaskStatus.Available", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(mockBackgroundTask.BackgroundTaskStatus.Available)

		await registerBackgroundSync()

		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync", { minimumInterval: 180 })
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
		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync", { minimumInterval: 180 })
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

	it("drives the camera phase with a soft deadline and no per-fire file cap when authed", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })

		await runTask()

		expect(mockCameraUpload.sync).toHaveBeenCalledTimes(1)

		const params = mockCameraUpload.sync.mock.calls[0]?.[0] as { background?: boolean; maxUploads?: number; deadlineAt?: number }

		expect(params.background).toBe(true)
		// The window is the budget. A fixed cap here is what limited background backup to a handful of
		// photos a day while the uncapped foreground pass did the real work.
		expect(params.maxUploads).toBeUndefined()

		const deadlineAt = params.deadlineAt

		expect(typeof deadlineAt).toBe("number")

		// Bounded on BOTH sides deliberately. An upper bound alone is satisfied by 0, by a past
		// timestamp, or by a sign-flipped `startedAt - RESERVE` — each of which would make the camera
		// phase stop before uploading anything, i.e. reintroduce the very bug this change fixes.
		expect(deadlineAt as number).toBeGreaterThan(Date.now())
		// Leaves the reserve so in-flight transfers land before the hard abort, which would otherwise
		// persist a background-abort against every one of them.
		expect((deadlineAt as number) - Date.now()).toBeLessThanOrEqual(BACKGROUND_RUN_BUDGET_MS - CAMERA_PHASE_RESERVE_MS)
	})

	it("records what the camera phase actually did in the run breadcrumb", async () => {
		// Both schedulers discard the task's return value, so this row is the only evidence a headless
		// run leaves. Recording "success" without saying whether anything uploaded — or why not — is
		// what made field reports of "background upload never works" unanswerable.
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockCameraUpload.sync.mockResolvedValue({ success: true, uploaded: 0, skipped: "lowPower" })

		await runTask()

		expect(backgroundRunLog.append).toHaveBeenCalledWith(
			expect.objectContaining({
				result: "success",
				cameraUploaded: 0,
				cameraSkipReason: "lowPower"
			})
		)
	})

	it("records the upload count for a run that did work", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockCameraUpload.sync.mockResolvedValue({ success: true, uploaded: 17 })

		await runTask()

		expect(backgroundRunLog.append).toHaveBeenCalledWith(expect.objectContaining({ cameraUploaded: 17 }))

		// Asserted by key ABSENCE, not `cameraSkipReason: undefined` — objectContaining ignores keys
		// whose expected value is undefined, so that form asserts nothing at all.
		const entry = vi.mocked(backgroundRunLog.append).mock.calls[0]?.[0] as Record<string, unknown>

		expect(entry["cameraSkipReason"]).toBeUndefined()
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
