import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("react-native", () => ({
	Platform: { OS: "android" }
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

beforeEach(() => {
	vi.clearAllMocks()
	vi.resetModules()
	mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })
	mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 2 })
})

describe("foregroundService", () => {
	it("init registers runner and creates channel without requesting permission", async () => {
		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.init()
		await fgs.init()

		expect(mockNotifee.registerForegroundService).toHaveBeenCalledTimes(1)
		expect(mockNotifee.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "transfers" }))
		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
	})

	it("start with AUTHORIZED status displays a DATA_SYNC FGS notification", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/lib/foregroundService")

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

	it("start with NOT_DETERMINED requests permission and displays on grant", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 2 })

		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })

		expect(mockNotifee.requestPermission).toHaveBeenCalledTimes(1)
		expect(mockNotifee.displayNotification).toHaveBeenCalled()
	})

	it("start with DENIED status silently no-ops", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 })

		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.start({ count: 2, progress: 0.1, speed: 1024 })

		expect(mockNotifee.requestPermission).not.toHaveBeenCalled()
		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("start with NOT_DETERMINED then user-deny memoizes the denial", async () => {
		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		mockNotifee.requestPermission.mockResolvedValue({ authorizationStatus: 1 })

		const { default: fgs } = await import("@/lib/foregroundService")

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

		const { default: fgs } = await import("@/lib/foregroundService")

		const controller = new AbortController()
		const startPromise = fgs.start({ count: 1, progress: 0, speed: 0 }, controller.signal)

		controller.abort()
		resolveRequest?.({ authorizationStatus: 2 })

		await startPromise
		await fgs.stop()

		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
		expect(mockNotifee.stopForegroundService).not.toHaveBeenCalled()
	})

	it("update before successful start is a no-op", async () => {
		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.update({ count: 1, progress: 0.5, speed: 0 })

		expect(mockNotifee.displayNotification).not.toHaveBeenCalled()
	})

	it("stop after successful start calls stopForegroundService once", async () => {
		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.start({ count: 1, progress: 0, speed: 0 })
		await fgs.stop()
		await fgs.stop()

		expect(mockNotifee.stopForegroundService).toHaveBeenCalledTimes(1)
	})

	it("getStatus reports the correct status", async () => {
		const { default: fgs } = await import("@/lib/foregroundService")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 })
		expect(await fgs.getStatus()).toBe("authorized")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 })
		expect(await fgs.getStatus()).toBe("denied")

		mockNotifee.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 })
		expect(await fgs.getStatus()).toBe("notDetermined")
	})

	it("openSettings opens Android notification settings", async () => {
		const { default: fgs } = await import("@/lib/foregroundService")

		await fgs.openSettings()

		expect(mockNotifee.openNotificationSettings).toHaveBeenCalledTimes(1)
	})

	it("is a no-op on iOS, getStatus returns notAndroid", async () => {
		vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }))

		const { default: fgs } = await import("@/lib/foregroundService")

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
})
