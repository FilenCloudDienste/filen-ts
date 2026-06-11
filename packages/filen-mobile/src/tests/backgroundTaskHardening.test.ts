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

const { mockTaskManager, mockBackgroundTask, mockRemoveListener, mockSetup, mockCameraUpload, capturedTaskCallback } = vi.hoisted(() => {
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
		addExpirationListener: vi.fn(() => ({ remove: mockRemoveListener }))
	}

	const mockSetup = { setup: vi.fn(async () => ({ isAuthed: false })) }

	const mockCameraUpload = { cancel: vi.fn(), sync: vi.fn(async () => undefined) }

	return { mockTaskManager, mockBackgroundTask, mockRemoveListener, mockSetup, mockCameraUpload, capturedTaskCallback }
})

vi.mock("expo-task-manager", () => mockTaskManager)

vi.mock("expo-background-task", () => mockBackgroundTask)

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/setup", () => ({ default: mockSetup }))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: mockCameraUpload }))

import "@/features/cameraUpload/backgroundTask"
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
