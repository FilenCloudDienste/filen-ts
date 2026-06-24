import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const platformMock = vi.hoisted(() => ({ OS: "android" as "ios" | "android" }))

vi.mock("react-native", () => ({
	Platform: platformMock
}))

const mockBpsToReadable = vi.fn((speed: number) => `${speed}B/s`)

vi.mock("@filen/utils", () => ({
	bpsToReadable: mockBpsToReadable
}))

const mockNotifee = {
	registerForegroundService: vi.fn(),
	createChannel: vi.fn().mockResolvedValue(undefined),
	requestPermission: vi.fn().mockResolvedValue({ authorizationStatus: 2 }),
	getNotificationSettings: vi.fn().mockResolvedValue({ authorizationStatus: 2 }),
	openNotificationSettings: vi.fn().mockResolvedValue(undefined),
	displayNotification: vi.fn().mockResolvedValue("id"),
	stopForegroundService: vi.fn().mockResolvedValue(undefined)
}

vi.mock("react-native-notify-kit", () => ({
	default: mockNotifee,
	AndroidImportance: { LOW: 2, HIGH: 4 },
	AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
	AuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3 }
}))

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// "Background transfers" setting. null → unset (defaults to enabled). Toggled per-test to assert
// start() gates on it.
const mockSecureStoreGet = vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(null)

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: mockSecureStoreGet
	},
	useSecureStore: vi.fn()
}))

beforeEach(() => {
	vi.clearAllMocks()
	vi.resetModules()
	platformMock.OS = "android"
	mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })
	mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 2 })
	mockNotifee.createChannel.mockResolvedValue(undefined)
	mockBpsToReadable.mockImplementation((speed: number) => `${speed}B/s`)
	mockSecureStoreGet.mockResolvedValue(null)
})

afterEach(() => {
	platformMock.OS = "android"
})

describe("foregroundService", () => {
	it("init registers runner and creates channel without requesting permission", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.init()
		await fgs.init()

		expect(mockNotifee.registerForegroundService).toHaveBeenCalledTimes(1)
		expect(mockNotifee.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "transfers" }))
		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
	})

	it("start with AUTHORIZED status displays a DATA_SYNC FGS notification", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.25, speed: 1024 })

		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "filen-transfers-fgs",
				android: expect.objectContaining({
					asForegroundService: true,
					foregroundServiceTypes: [1]
				})
			})
		)
	})

	it("isRunning() reflects the start → stop lifecycle", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		expect(fgs.isRunning()).toBe(false)

		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(fgs.isRunning()).toBe(true)

		await fgs.stop()

		expect(fgs.isRunning()).toBe(false)
	})

	it("TC-10: isRunning() stays false when start is rejected (e.g. background-start), so the host can retry", async () => {
		mockNotifee.displayNotification.mockRejectedValueOnce(new Error("ForegroundServiceStartNotAllowedException"))

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await expect(fgs.start({ count: 1, progress: 0, speed: 0 })).rejects.toThrow()

		expect(fgs.isRunning()).toBe(false)
	})

	it("start with NOT_DETERMINED requests permission and displays notification with correct payload shape on grant", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(mockNotifee.requestPermission).toHaveBeenCalledTimes(1)
		expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "filen-transfers-fgs",
				android: expect.objectContaining({
					asForegroundService: true,
					foregroundServiceTypes: [1]
				})
			})
		)
	})

	it("start no-ops when the Background transfers setting is disabled (never inits or requests permission)", async () => {
		mockSecureStoreGet.mockResolvedValue(false)

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.5, speed: 1024 })

		expect(mockSecureStoreGet).toHaveBeenCalledWith("transfersForegroundServiceEnabled")
		expect(mockNotifee.registerForegroundService).not.toHaveBeenCalled()
		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("start proceeds when the Background transfers setting is explicitly enabled", async () => {
		mockSecureStoreGet.mockResolvedValue(true)
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.25, speed: 1024 })

		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)
	})

	it("start treats an unset Background transfers setting as enabled (default on)", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.25, speed: 1024 })

		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)
	})

	it("start with DENIED status silently no-ops", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.start({ count: 2, progress: 0.1, speed: 1024 })

		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("start with NOT_DETERMINED then user-deny memoizes the denial", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 1 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(mockNotifee.requestPermission).toHaveBeenCalledTimes(1)
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("start aborted during permission await skips display", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })

		let resolveRequest: ((value: { authorizationStatus: number }) => void) | undefined
		mockNotifee.requestPermission.mockReturnValue(
			new Promise(resolve => {
				resolveRequest = resolve
			})
		)

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		const controller = new AbortController()
		const startPromise = fgs.start({ count: 1, progress: 0, speed: 0 }, controller.signal)

		controller.abort()
		resolveRequest?.({ authorizationStatus: 2 })

		await startPromise
		await fgs.stop()

		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
		expect(mockNotifee.stopForegroundService).not.toHaveBeenCalled()
	})

	it("start with an already-aborted signal skips init and display", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		const controller = new AbortController()
		controller.abort()

		await fgs.start({ count: 1, progress: 0.5, speed: 512 }, controller.signal)

		expect(mockNotifee.registerForegroundService).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("update before successful start is a no-op", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.update({ count: 1, progress: 0.5, speed: 0 })

		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("update after successful start calls displayNotification with the new progress payload", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.25, speed: 512 })

		vi.clearAllMocks()
		mockBpsToReadable.mockImplementation((speed: number) => `${speed}B/s`)

		await fgs.update({ count: 3, progress: 0.75, speed: 2048 })

		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)
		expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "filen-transfers-fgs",
				android: expect.objectContaining({
					asForegroundService: true,
					foregroundServiceTypes: [1],
					progress: expect.objectContaining({
						max: 100,
						current: 75,
						indeterminate: false
					})
				})
			})
		)
	})

	it("stop after successful start calls stopForegroundService once", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.stop()
		await fgs.stop()

		expect(mockNotifee.stopForegroundService).toHaveBeenCalledTimes(1)
	})

	it("TC-11: stop clears running and swallows a failing stopForegroundService (no permanent zombie)", async () => {
		mockNotifee.stopForegroundService.mockRejectedValueOnce(new Error("teardown failed"))

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(fgs.isRunning()).toBe(true)

		// A throwing native teardown must NOT leave `running` true forever — that would block every
		// future start()/update(). stop() resolves (error swallowed) and the mirror is cleared.
		await expect(fgs.stop()).resolves.toBeUndefined()

		expect(fgs.isRunning()).toBe(false)
	})

	it("TC-11: update clears running when displayNotification rejects, so the host can re-arm start()", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.25, speed: 512 })

		expect(fgs.isRunning()).toBe(true)

		// A reissued display can be rejected when the service is no longer live (OS FGS timeout) or the
		// app is backgrounded. update() must self-heal by clearing `running` rather than throwing.
		mockNotifee.displayNotification.mockRejectedValueOnce(new Error("service not live"))

		await expect(fgs.update({ count: 1, progress: 0.5, speed: 1024 })).resolves.toBeUndefined()

		expect(fgs.isRunning()).toBe(false)
	})

	it("getStatus reports the correct status", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })
		expect(await fgs.getStatus()).toBe("authorized")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 })
		expect(await fgs.getStatus()).toBe("denied")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		expect(await fgs.getStatus()).toBe("notDetermined")
	})

	it("getStatus with PROVISIONAL authorization returns 'authorized'", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 3 })

		expect(await fgs.getStatus()).toBe("authorized")
	})

	it("start with PROVISIONAL from requestPermission displays notification with correct payload shape", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 3 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(mockNotifee.requestPermission).toHaveBeenCalledTimes(1)
		expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "filen-transfers-fgs",
				android: expect.objectContaining({
					asForegroundService: true,
					foregroundServiceTypes: [1]
				})
			})
		)
	})

	it("openSettings opens Android notification settings", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.openSettings()

		expect(mockNotifee.openNotificationSettings).toHaveBeenCalledTimes(1)
	})

	it("display sets progress.current to clamped percent and indeterminate false when ratio > 0", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 2, progress: 0.6, speed: 1024 })

		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)

		const call = mockNotifee.displayNotification.mock.calls[0]?.[0] as {
			android: { progress: { max: number; current: number; indeterminate: boolean } }
		}

		expect(call.android.progress.max).toBe(100)
		expect(call.android.progress.current).toBe(60)
		expect(call.android.progress.indeterminate).toBe(false)
	})

	it("display sets indeterminate true when count > 0 and ratio is 0", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 3, progress: 0, speed: 0 })

		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)

		const call = mockNotifee.displayNotification.mock.calls[0]?.[0] as {
			android: { progress: { max: number; current: number; indeterminate: boolean } }
		}

		expect(call.android.progress.indeterminate).toBe(true)
		expect(call.android.progress.current).toBe(0)
	})

	it("display uses em-dash speedText and does not call bpsToReadable when speed is zero", async () => {
		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.5, speed: 0 })

		expect(mockBpsToReadable).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).toHaveBeenCalledTimes(1)
	})

	it("display calls bpsToReadable when speed is non-zero", async () => {
		mockBpsToReadable.mockReturnValue("512 B/s")

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.start({ count: 1, progress: 0.5, speed: 512 })

		expect(mockBpsToReadable).toHaveBeenCalledWith(512)
	})

	it("init error-reset recovery: failed init resets initPromise so a retry succeeds", async () => {
		const error = new Error("channel creation failed")
		mockNotifee.createChannel.mockRejectedValueOnce(error)

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		// First call: createChannel rejects → initPromise is reset and error is thrown
		await expect(fgs.init()).rejects.toThrow("channel creation failed")

		// Reset createChannel to succeed for the retry
		mockNotifee.createChannel.mockResolvedValueOnce(undefined)

		// Second call: should retry because initPromise was reset to null on failure
		await fgs.init()

		expect(mockNotifee.createChannel).toHaveBeenCalledTimes(2)
	})

	it("is a no-op on iOS, getStatus returns notAndroid", async () => {
		platformMock.OS = "ios"

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		await fgs.init()
		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.stop()
		await fgs.openSettings()

		expect(await fgs.getStatus()).toBe("notAndroid")
		expect(mockNotifee.registerForegroundService).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
		expect(mockNotifee.stopForegroundService).not.toHaveBeenCalled()
		expect(mockNotifee.openNotificationSettings).not.toHaveBeenCalled()
	})

	it("requestPermission returns true when getNotificationSettings reports AUTHORIZED", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		expect(await fgs.requestPermission()).toBe(true)
		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
	})

	it("requestPermission returns false when getNotificationSettings reports DENIED", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 })

		const { default: fgs } = await import("@/features/transfers/foregroundService")

		expect(await fgs.requestPermission()).toBe(false)
		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
	})
})
