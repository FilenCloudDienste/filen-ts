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

const { mockTaskManager, mockBackgroundTask, mockRemoveListener, mockSetup, mockCameraUpload, mockOfflineSync, mockSecureStoreGet, capturedTaskCallback } =
	vi.hoisted(() => {
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

	const mockCameraUpload = { cancel: vi.fn(), sync: vi.fn(async () => undefined) }

	const mockOfflineSync = { cancel: vi.fn(), sync: vi.fn(async () => undefined) }

	const mockSecureStoreGet = vi.fn(async () => null as unknown)

	return {
		mockTaskManager,
		mockBackgroundTask,
		mockRemoveListener,
		mockSetup,
		mockCameraUpload,
		mockOfflineSync,
		mockSecureStoreGet,
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
	mockCameraUpload.sync.mockResolvedValue(undefined)
	mockOfflineSync.sync.mockResolvedValue(undefined)
	mockSecureStoreGet.mockResolvedValue(null)
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
					new Promise<undefined>(resolve => {
						releaseSync = () => resolve(undefined)
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
})
