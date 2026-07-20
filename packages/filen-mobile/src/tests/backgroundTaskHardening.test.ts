/**
 * HARDENING suite for src/features/cameraUpload/backgroundTask.ts — added by the
 * background-task audit (2026-06-11).
 *
 * What this file pins that backgroundTask.test.ts does not: the FAILURE path of the
 * task callback. The OS schedulers (BGTaskScheduler / WorkManager) feed the returned
 * BackgroundTaskResult into their retry/budget heuristics — a task body that swallows a
 * setup failure and reports Success teaches the OS that a broken run was fine. The
 * existing suite pins Success for the authed and unauthed HAPPY paths only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const {
	mockTaskManager,
	mockBackgroundTask,
	mockRemoveListener,
	mockSetup,
	mockCameraUpload,
	mockOfflineSync,
	mockSecureStoreGet,
	mockKvFlushNow,
	mockRunLogAppend,
	capturedTaskCallback
} = vi.hoisted(() => {
	const mockRemoveListener = vi.fn()
	const capturedTaskCallback: { fn: ((data: unknown) => Promise<unknown>) | null } = { fn: null }

	const mockTaskManager = {
		defineTask: vi.fn((_name: string, fn: (data: unknown) => Promise<unknown>) => {
			capturedTaskCallback.fn = fn
		}),
		isTaskRegisteredAsync: vi.fn(async () => false)
	}

	const mockBackgroundTask = {
		BackgroundTaskStatus: { Restricted: 1, Available: 2 },
		BackgroundTaskResult: { Success: 1, Failed: 2 },
		getStatusAsync: vi.fn(async () => 2),
		registerTaskAsync: vi.fn(async () => undefined),
		unregisterTaskAsync: vi.fn(async () => undefined),
		addExpirationListener: vi.fn((_listener: () => void) => ({ remove: mockRemoveListener }))
	}

	const mockSetup = { setup: vi.fn(async () => ({ isAuthed: false })) }

	const mockCameraUpload = { cancel: vi.fn(), sync: vi.fn(async (): Promise<{ success: boolean; error?: unknown }> => ({ success: true })) }

	const mockOfflineSync = { cancel: vi.fn(), sync: vi.fn(async () => undefined) }

	const mockSecureStoreGet = vi.fn(async () => null as unknown)

	const mockKvFlushNow = vi.fn(async () => undefined)

	const mockRunLogAppend = vi.fn(async () => undefined)

	return {
		mockTaskManager,
		mockBackgroundTask,
		mockRemoveListener,
		mockSetup,
		mockCameraUpload,
		mockOfflineSync,
		mockSecureStoreGet,
		mockKvFlushNow,
		mockRunLogAppend,
		capturedTaskCallback
	}
})

vi.mock("expo-task-manager", () => mockTaskManager)

vi.mock("expo-background-task", () => mockBackgroundTask)

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/setup", () => ({ default: mockSetup }))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: mockCameraUpload }))

vi.mock("@/features/offline/offlineSync", () => ({ default: mockOfflineSync }))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: mockSecureStoreGet
	}
}))

vi.mock("@/features/offline/offlineHelpers", () => ({
	OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY: "offlineBackgroundSync"
}))

vi.mock("@/queries/client", () => ({
	queryClientPersisterKv: {
		flushNow: mockKvFlushNow
	}
}))

vi.mock("@/features/cameraUpload/backgroundRunLog", () => ({
	default: {
		append: mockRunLogAppend
	}
}))

import "@/features/cameraUpload/backgroundTask"
import { BACKGROUND_RUN_BUDGET_MS } from "@/features/cameraUpload/backgroundTask"
import { Platform } from "react-native"

async function runTask(): Promise<unknown> {
	if (!capturedTaskCallback.fn) {
		throw new Error("TaskManager.defineTask callback was never captured")
	}

	return capturedTaskCallback.fn({})
}

beforeEach(() => {
	vi.clearAllMocks()
	mockBackgroundTask.addExpirationListener.mockReturnValue({ remove: mockRemoveListener })
	mockSetup.setup.mockResolvedValue({ isAuthed: false })
	mockCameraUpload.sync.mockResolvedValue({ success: true })
	mockOfflineSync.sync.mockResolvedValue(undefined)
	mockSecureStoreGet.mockResolvedValue(null)
	mockKvFlushNow.mockResolvedValue(undefined)
	mockRunLogAppend.mockResolvedValue(undefined)
	;(Platform as { OS: string }).OS = "ios"
})

describe("hardening — task callback failure path", () => {
	it("returns BackgroundTaskResult.Failed when setup rejects (never report a broken run as Success)", async () => {
		mockSetup.setup.mockRejectedValue(new Error("sqlite open failed"))

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Failed)
	})

	it("returns BackgroundTaskResult.Failed when sync rejects", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockCameraUpload.sync.mockRejectedValue(new Error("sync exploded"))

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Failed)
	})

	it("removes the iOS expiration listener even when the task body fails", async () => {
		;(Platform as { OS: string }).OS = "ios"
		mockSetup.setup.mockRejectedValue(new Error("boom"))

		await runTask()

		expect(mockRemoveListener).toHaveBeenCalledTimes(1)
	})

	it("still returns Success for the healthy authed run", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Success)
	})
})

describe("hardening — budgeted offline phase wiring", () => {
	it("runs the offline pass AFTER camera upload when the setting is enabled and authed", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)

		await runTask()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync.sync).toHaveBeenCalledWith({ background: true })

		const cameraOrder = mockCameraUpload.sync.mock.invocationCallOrder[0] as number
		const offlineOrder = mockOfflineSync.sync.mock.invocationCallOrder[0] as number

		expect(cameraOrder).toBeLessThan(offlineOrder)
	})

	it("does NOT run the offline pass when the setting is off/absent", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(null)

		await runTask()

		expect(mockOfflineSync.sync).not.toHaveBeenCalled()
	})

	it("does NOT run the offline pass when not authed, even with the setting enabled", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })
		mockSecureStoreGet.mockResolvedValue(true)

		await runTask()

		expect(mockOfflineSync.sync).not.toHaveBeenCalled()
	})

	it("skips the offline pass when the camera phase consumed the run budget (min-remaining gate)", async () => {
		vi.useFakeTimers()

		try {
			mockSetup.setup.mockResolvedValue({ isAuthed: true })
			mockSecureStoreGet.mockResolvedValue(true)
			mockCameraUpload.sync.mockImplementation(async () => {
				// Camera phase eats almost the whole budget (fake clock — Date.now advances).
				vi.advanceTimersByTime(BACKGROUND_RUN_BUDGET_MS - 5_000)

				return { success: true }
			})

			await runTask()

			expect(mockOfflineSync.sync).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("the run-budget deadline cancels BOTH engines", async () => {
		vi.useFakeTimers()

		try {
			mockSetup.setup.mockResolvedValue({ isAuthed: true })

			let releaseSync!: () => void

			mockCameraUpload.sync.mockImplementation(
				() =>
					new Promise<{ success: boolean }>(resolve => {
						releaseSync = () => resolve({ success: true })
					})
			)

			const taskPromise = runTask()

			// Let the task reach the hanging camera sync, then blow the budget.
			await vi.advanceTimersByTimeAsync(BACKGROUND_RUN_BUDGET_MS + 1_000)

			expect(mockCameraUpload.cancel).toHaveBeenCalledTimes(1)
			expect(mockOfflineSync.cancel).toHaveBeenCalledTimes(1)

			releaseSync()

			await taskPromise
		} finally {
			vi.useRealTimers()
		}
	})

	it("the iOS expiration listener cancels BOTH engines", async () => {
		;(Platform as { OS: string }).OS = "ios"
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		let expirationCallback: (() => void) | null = null

		mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
			expirationCallback = cb

			return { remove: mockRemoveListener }
		})

		await runTask()

		expect(expirationCallback).not.toBeNull()

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expirationCallback!()

		expect(mockCameraUpload.cancel).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync.cancel).toHaveBeenCalledTimes(1)
	})

	it("an expiration during the camera phase prevents the offline phase from STARTING (cancel() swaps in a fresh AbortController)", async () => {
		// Both engines' cancel() abort the CURRENT controller and immediately swap in a
		// fresh one for the next run — so a cancel landing between phases aborts nothing.
		// Without a run-local cancelled flag, an iOS expiration at t=30s would leave
		// remaining = 90s > the 15s gate and the offline pass would start un-aborted
		// AFTER the OS said stop.
		;(Platform as { OS: string }).OS = "ios"
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)

		let expirationCallback: (() => void) | null = null

		mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
			expirationCallback = cb

			return { remove: mockRemoveListener }
		})

		mockCameraUpload.sync.mockImplementation(async () => {
			expirationCallback?.()

			return { success: true }
		})

		await runTask()

		expect(mockOfflineSync.cancel).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync.sync).not.toHaveBeenCalled()
	})

	it("an expiration during setup prevents the camera phase from STARTING", async () => {
		;(Platform as { OS: string }).OS = "ios"
		mockSecureStoreGet.mockResolvedValue(true)

		let expirationCallback: (() => void) | null = null

		mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
			expirationCallback = cb

			return { remove: mockRemoveListener }
		})

		mockSetup.setup.mockImplementation(async () => {
			expirationCallback?.()

			return { isAuthed: true }
		})

		await runTask()

		expect(mockCameraUpload.sync).not.toHaveBeenCalled()
		expect(mockOfflineSync.sync).not.toHaveBeenCalled()
	})
})

describe("hardening — persist-before-suspend flushes", () => {
	// The storedOffline query broadcasts still debounce through QueryPersisterKv, which normally
	// flushes on the AppState "background" transition — never fired in a headless task run (the app
	// is ALREADY backgrounded). The OS may suspend the process the moment the task callback returns,
	// so the task must flush the query persister and AWAIT the write landing. (The camera-upload
	// ledger writes through synchronously now, so it needs no flush.)
	it("flushes the query persister after the sync phases (healthy authed run)", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)

		await runTask()

		expect(mockKvFlushNow).toHaveBeenCalledTimes(1)

		const cameraOrder = mockCameraUpload.sync.mock.invocationCallOrder[0] as number
		const offlineOrder = mockOfflineSync.sync.mock.invocationCallOrder[0] as number
		const kvFlushOrder = mockKvFlushNow.mock.invocationCallOrder[0] as number

		expect(kvFlushOrder).toBeGreaterThan(cameraOrder)
		expect(kvFlushOrder).toBeGreaterThan(offlineOrder)
	})

	it("flushes the query persister on the unauthed early return too (defers cover every exit path)", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		await runTask()

		expect(mockKvFlushNow).toHaveBeenCalledTimes(1)
	})

	it("writes exactly one run-log breadcrumb per run, after the phases (healthy authed run)", async () => {
		// Audit B6 (2026-06-11): release builds no-op console.* and BOTH OS schedulers
		// discard the returned result (expo-background-task always reports success to the
		// OS) — the persisted breadcrumb is the only field-diagnosable trace of a run.
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)

		await runTask()

		expect(mockRunLogAppend).toHaveBeenCalledTimes(1)
		expect(mockRunLogAppend).toHaveBeenCalledWith(
			expect.objectContaining({
				v: 1,
				phase: "done",
				cancelled: false,
				result: "success"
			})
		)

		const offlineOrder = mockOfflineSync.sync.mock.invocationCallOrder[0] as number
		const appendOrder = mockRunLogAppend.mock.invocationCallOrder[0] as number

		expect(appendOrder).toBeGreaterThan(offlineOrder)
	})

	it("breadcrumb for an unauthed run records phase 'setup' with result 'success'", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: false })

		await runTask()

		expect(mockRunLogAppend).toHaveBeenCalledTimes(1)
		expect(mockRunLogAppend).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "setup",
				cancelled: false,
				result: "success"
			})
		)
	})

	it("breadcrumb for a setup failure records result 'failed' with the error message", async () => {
		mockSetup.setup.mockRejectedValue(new Error("sqlite open failed"))

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Failed)
		expect(mockRunLogAppend).toHaveBeenCalledTimes(1)
		expect(mockRunLogAppend).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "setup",
				result: "failed",
				errorMessage: "sqlite open failed"
			})
		)
	})

	it("BG-01: a swallowed camera-phase failure records result 'failed' and returns Failed (not Success)", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		// cameraUpload.sync never rejects — it surfaces the swallowed failure via its result.
		mockCameraUpload.sync.mockResolvedValue({ success: false, error: new Error("listing exploded") })

		const result = await runTask()

		// Pre-fix this returned Success and recorded "success" — blinding field diagnosis of the camera half.
		// (The run still progresses past the camera phase — a camera failure flags the outcome but doesn't
		// halt the offline check — so phase reaches "done"; the failure rides the result/errorMessage.)
		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Failed)
		expect(mockRunLogAppend).toHaveBeenCalledWith(
			expect.objectContaining({
				result: "failed",
				errorMessage: "listing exploded"
			})
		)
	})

	it("breadcrumb for an expiration during the camera phase records phase 'camera' + cancelled", async () => {
		;(Platform as { OS: string }).OS = "ios"
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)

		let expirationCallback: (() => void) | null = null

		mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
			expirationCallback = cb

			return { remove: mockRemoveListener }
		})

		mockCameraUpload.sync.mockImplementation(async () => {
			expirationCallback?.()

			return { success: true }
		})

		await runTask()

		expect(mockRunLogAppend).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "camera",
				cancelled: true,
				result: "success"
			})
		)
	})

	it("BG-02: a throwing engine cancel does not block the other engine's cancel", async () => {
		;(Platform as { OS: string }).OS = "ios"
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockSecureStoreGet.mockResolvedValue(true)
		mockCameraUpload.cancel.mockImplementation(() => {
			throw new Error("cancel boom")
		})

		let expirationCallback: (() => void) | null = null

		mockBackgroundTask.addExpirationListener.mockImplementation((cb: () => void) => {
			expirationCallback = cb

			return { remove: mockRemoveListener }
		})

		// Fire the expiration mid-camera-phase → cancelRun → cancelBackgroundWork, where
		// cameraUpload.cancel() throws.
		mockCameraUpload.sync.mockImplementation(async () => {
			expirationCallback?.()

			return { success: true }
		})

		await runTask()

		expect(mockCameraUpload.cancel).toHaveBeenCalled()
		// Pre-fix the throw escaped cancelBackgroundWork before reaching offlineSync.cancel; the per-engine
		// try/catch must keep the second cancel reachable.
		expect(mockOfflineSync.cancel).toHaveBeenCalled()
	})

	it("a breadcrumb write failure never flips a healthy run's result", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })
		mockRunLogAppend.mockRejectedValue(new Error("kv write failed"))

		const result = await runTask()

		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Success)
	})

	it("does not report completion until the flush promises settle (the OS may suspend immediately after)", async () => {
		mockSetup.setup.mockResolvedValue({ isAuthed: true })

		let releaseFlush!: () => void

		mockKvFlushNow.mockImplementation(
			() =>
				new Promise<undefined>(resolve => {
					releaseFlush = () => resolve(undefined)
				})
		)

		let settled = false

		const taskPromise = runTask().then(result => {
			settled = true

			return result
		})

		// Drain the task body's await chain (real timers; two macrotask hops flush all
		// intermediate microtasks) — the task must still be parked on the flush.
		await new Promise<void>(resolve => {
			setTimeout(resolve, 0)
		})
		await new Promise<void>(resolve => {
			setTimeout(resolve, 0)
		})

		expect(settled).toBe(false)

		releaseFlush()

		const result = await taskPromise

		expect(settled).toBe(true)
		expect(result).toBe(mockBackgroundTask.BackgroundTaskResult.Success)
	})
})
