import { describe, it, expect, beforeEach, vi } from "vitest"

const mockTaskManager = {
	defineTask: vi.fn(),
	isTaskRegisteredAsync: vi.fn().mockResolvedValue(false)
}

vi.mock("expo-task-manager", () => mockTaskManager)

const mockBackgroundTask = {
	BackgroundTaskStatus: { Restricted: 1, Available: 2 },
	BackgroundTaskResult: { Success: 1, Failed: 2 },
	getStatusAsync: vi.fn().mockResolvedValue(2),
	registerTaskAsync: vi.fn().mockResolvedValue(undefined),
	unregisterTaskAsync: vi.fn().mockResolvedValue(undefined),
	addExpirationListener: vi.fn().mockReturnValue({ remove: vi.fn() })
}

vi.mock("expo-background-task", () => mockBackgroundTask)

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/setup", () => ({
	default: { setup: vi.fn().mockResolvedValue({ isAuthed: false }) }
}))

vi.mock("@/lib/cameraUpload", () => ({
	default: { cancel: vi.fn(), sync: vi.fn().mockResolvedValue(undefined) }
}))

beforeEach(() => {
	vi.clearAllMocks()
	vi.resetModules()
	mockBackgroundTask.getStatusAsync.mockResolvedValue(2)
	mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false)
	mockBackgroundTask.registerTaskAsync.mockResolvedValue(undefined)
	mockBackgroundTask.unregisterTaskAsync.mockResolvedValue(undefined)
})

describe("registerBackgroundSync", () => {
	it("registers the task when status is Available", async () => {
		const { registerBackgroundSync } = await import("@/lib/backgroundTask")

		await registerBackgroundSync()

		expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith(
			"filen-camera-upload-sync",
			{ minimumInterval: 15 }
		)
	})

	it("skips registration when status is Restricted", async () => {
		mockBackgroundTask.getStatusAsync.mockResolvedValue(1)

		const { registerBackgroundSync } = await import("@/lib/backgroundTask")

		await registerBackgroundSync()

		expect(mockBackgroundTask.registerTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when getStatusAsync rejects", async () => {
		mockBackgroundTask.getStatusAsync.mockRejectedValue(new Error("unavailable"))

		const { registerBackgroundSync } = await import("@/lib/backgroundTask")

		await expect(registerBackgroundSync()).resolves.toBeUndefined()
		expect(mockBackgroundTask.registerTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when registerTaskAsync rejects", async () => {
		mockBackgroundTask.registerTaskAsync.mockRejectedValue(new Error("register failed"))

		const { registerBackgroundSync } = await import("@/lib/backgroundTask")

		await expect(registerBackgroundSync()).resolves.toBeUndefined()
	})
})

describe("unregisterBackgroundSync", () => {
	it("unregisters the task when it is registered", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true)

		const { unregisterBackgroundSync } = await import("@/lib/backgroundTask")

		await unregisterBackgroundSync()

		expect(mockBackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith("filen-camera-upload-sync")
	})

	it("skips unregistration when the task is not registered", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false)

		const { unregisterBackgroundSync } = await import("@/lib/backgroundTask")

		await unregisterBackgroundSync()

		expect(mockBackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when isTaskRegisteredAsync rejects", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockRejectedValue(new Error("query failed"))

		const { unregisterBackgroundSync } = await import("@/lib/backgroundTask")

		await expect(unregisterBackgroundSync()).resolves.toBeUndefined()
		expect(mockBackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled()
	})

	it("does not throw when unregisterTaskAsync rejects", async () => {
		mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true)
		mockBackgroundTask.unregisterTaskAsync.mockRejectedValue(new Error("unregister failed"))

		const { unregisterBackgroundSync } = await import("@/lib/backgroundTask")

		await expect(unregisterBackgroundSync()).resolves.toBeUndefined()
	})
})
