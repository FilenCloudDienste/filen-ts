import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	mockIsOnline,
	capturedSubscribers,
	mockCameraUploadSync,
	mockOfflineSync,
	mockNotesExecuteNow,
	mockChatsSyncNow
} = vi.hoisted(() => {
	let _online = false

	return {
		mockIsOnline: {
			set online(v: boolean) { _online = v },
			get online() { return _online }
		},
		capturedSubscribers: [] as ((isOnline: boolean) => void)[],
		mockCameraUploadSync: vi.fn().mockResolvedValue(undefined),
		mockOfflineSync: vi.fn().mockResolvedValue(undefined),
		mockNotesExecuteNow: vi.fn(),
		mockChatsSyncNow: vi.fn()
	}
})

vi.mock("@tanstack/react-query", () => ({
	onlineManager: {
		isOnline: () => mockIsOnline.online,
		subscribe: (fn: (isOnline: boolean) => void) => {
			capturedSubscribers.push(fn)
			return () => {
				const idx = capturedSubscribers.indexOf(fn)
				if (idx !== -1) capturedSubscribers.splice(idx, 1)
			}
		}
	}
}))

vi.mock("@/lib/offline", () => ({ default: { sync: () => mockOfflineSync() } }))
vi.mock("@/lib/cameraUpload", () => ({ default: { sync: () => mockCameraUploadSync() } }))
vi.mock("@/components/notes/sync", () => ({ sync: { executeNow: () => mockNotesExecuteNow() } }))
vi.mock("@/components/chats/sync", () => ({ sync: { syncNow: () => mockChatsSyncNow() } }))

function fireOnlineEvent(isOnline: boolean) {
	for (const sub of capturedSubscribers) { sub(isOnline) }
}

beforeEach(() => {
	vi.resetModules()
	capturedSubscribers.length = 0
	mockIsOnline.online = false
	mockCameraUploadSync.mockClear()
	mockOfflineSync.mockClear()
	mockNotesExecuteNow.mockClear()
	mockChatsSyncNow.mockClear()
})

describe("startReconnectListener", () => {
	it("fires all four sync calls on an offline->online transition", async () => {
		const { startReconnectListener } = await import("@/lib/reconnect")
		startReconnectListener()
		fireOnlineEvent(true)
		expect(mockCameraUploadSync).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync).toHaveBeenCalledTimes(1)
		expect(mockNotesExecuteNow).toHaveBeenCalledTimes(1)
		expect(mockChatsSyncNow).toHaveBeenCalledTimes(1)
	})

	it("does not fire syncs when the device goes offline (online->offline transition)", async () => {
		mockIsOnline.online = true
		const { startReconnectListener } = await import("@/lib/reconnect")
		startReconnectListener()
		fireOnlineEvent(false)
		expect(mockCameraUploadSync).not.toHaveBeenCalled()
		expect(mockOfflineSync).not.toHaveBeenCalled()
		expect(mockNotesExecuteNow).not.toHaveBeenCalled()
		expect(mockChatsSyncNow).not.toHaveBeenCalled()
	})

	it("deduplicates events — subscriber with same value twice only fires syncs once", async () => {
		const { startReconnectListener } = await import("@/lib/reconnect")
		startReconnectListener()
		fireOnlineEvent(true)
		fireOnlineEvent(true)
		expect(mockCameraUploadSync).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync).toHaveBeenCalledTimes(1)
		expect(mockNotesExecuteNow).toHaveBeenCalledTimes(1)
		expect(mockChatsSyncNow).toHaveBeenCalledTimes(1)
	})

	it("is idempotent — calling startReconnectListener twice registers only one subscriber", async () => {
		const { startReconnectListener } = await import("@/lib/reconnect")
		startReconnectListener()
		startReconnectListener()
		expect(capturedSubscribers).toHaveLength(1)
		fireOnlineEvent(true)
		expect(mockCameraUploadSync).toHaveBeenCalledTimes(1)
		expect(mockOfflineSync).toHaveBeenCalledTimes(1)
		expect(mockNotesExecuteNow).toHaveBeenCalledTimes(1)
		expect(mockChatsSyncNow).toHaveBeenCalledTimes(1)
	})

	it("fires syncs a second time when the device reconnects after an intermediate offline period", async () => {
		const { startReconnectListener } = await import("@/lib/reconnect")
		startReconnectListener()
		fireOnlineEvent(true)
		fireOnlineEvent(false)
		fireOnlineEvent(true)
		expect(mockCameraUploadSync).toHaveBeenCalledTimes(2)
		expect(mockOfflineSync).toHaveBeenCalledTimes(2)
		expect(mockNotesExecuteNow).toHaveBeenCalledTimes(2)
		expect(mockChatsSyncNow).toHaveBeenCalledTimes(2)
	})
})
