import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { callLog } = vi.hoisted(() => {
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	return {
		callLog: [] as string[]
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/sdk-rs", () => ({
	UnauthJsClient: {
		fromConfig: vi.fn(() => ({
			fromStringified: vi.fn(),
			login: vi.fn()
		}))
	},
	FilenSdkError: class FilenSdkError extends Error {},
	LogLevel: { Info: "Info", Debug: "Debug", Warn: "Warn", Error: "Error", Trace: "Trace" }
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		clear: vi.fn(async () => {
			callLog.push("secureStore.clear")
		}),
		remove: vi.fn(async (key: string) => {
			callLog.push(`secureStore.remove:${key}`)
		}),
		get: vi.fn(async () => null),
		set: vi.fn(async () => undefined)
	},
	useSecureStore: vi.fn()
}))

vi.mock("@/lib/transfers", () => ({
	default: {
		cancelAll: vi.fn(() => {
			callLog.push("transfers.cancelAll")
		})
	}
}))

vi.mock("@/lib/cameraUpload", () => ({
	default: {
		cancel: vi.fn(() => {
			callLog.push("cameraUpload.cancel")
		})
	}
}))

vi.mock("@/components/chats/sync", () => ({
	sync: {
		cancel: vi.fn(() => {
			callLog.push("chatsSync.cancel")
		})
	},
	SyncHost: vi.fn()
}))

vi.mock("@/components/notes/sync", () => ({
	sync: {
		cancel: vi.fn(() => {
			callLog.push("notesSync.cancel")
		})
	},
	SyncHost: vi.fn()
}))

vi.mock("@/lib/offline", () => ({
	default: {
		cancel: vi.fn(() => {
			callLog.push("offline.cancel")
		})
	}
}))

vi.mock("@/lib/backgroundTask", () => ({
	unregisterBackgroundSync: vi.fn(async () => {
		callLog.push("unregisterBackgroundSync")
	})
}))

vi.mock("@/lib/fileProvider", () => ({
	default: {
		disable: vi.fn(async () => {
			callLog.push("fileProvider.disable")
		})
	}
}))

vi.mock("@/lib/sqlite", () => ({
	default: {
		clearAsync: vi.fn(async () => {
			callLog.push("sqlite.clearAsync")
		})
	}
}))

vi.mock("@/lib/audio", () => ({
	default: {
		stop: vi.fn(async () => {
			callLog.push("audio.stop")
		})
	}
}))

vi.mock("expo", () => ({
	reloadAppAsync: vi.fn(async () => {
		callLog.push("reloadAppAsync")
	})
}))

import auth from "@/lib/auth"

type AuthInternals = {
	logoutPromise: Promise<void> | null
}

function authInternals(): AuthInternals {
	return auth as unknown as AuthInternals
}

beforeEach(() => {
	callLog.length = 0
	authInternals().logoutPromise = null
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("auth.logout", () => {
	it("runs the teardown in dependency order", async () => {
		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		expect(callLog).toEqual([
			"unregisterBackgroundSync",
			"audio.stop",
			"fileProvider.disable",
			"transfers.cancelAll",
			"cameraUpload.cancel",
			"chatsSync.cancel",
			"notesSync.cancel",
			"offline.cancel",
			"secureStore.clear",
			"sqlite.clearAsync",
			"reloadAppAsync"
		])
	})

	it("cancels chats, notes and offline sync alongside transfers and camera upload", async () => {
		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const audioIdx = callLog.indexOf("audio.stop")
		const transfersIdx = callLog.indexOf("transfers.cancelAll")
		const chatsIdx = callLog.indexOf("chatsSync.cancel")
		const notesIdx = callLog.indexOf("notesSync.cancel")
		const offlineIdx = callLog.indexOf("offline.cancel")

		expect(audioIdx).toBeGreaterThanOrEqual(0)
		expect(transfersIdx).toBeGreaterThan(audioIdx)
		expect(chatsIdx).toBeGreaterThan(transfersIdx)
		expect(notesIdx).toBeGreaterThan(chatsIdx)
		expect(offlineIdx).toBeGreaterThan(notesIdx)
	})

	it("removes auth secret before reloading the app", async () => {
		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const secureClear = callLog.indexOf("secureStore.clear")
		const reload = callLog.indexOf("reloadAppAsync")

		expect(secureClear).toBeGreaterThanOrEqual(0)
		expect(reload).toBeGreaterThan(secureClear)
	})

	it("concurrent calls share the same in-flight teardown (Promise guard)", async () => {
		const a = auth.logout()
		const b = auth.logout()
		const c = auth.logout()

		await vi.runAllTimersAsync()
		await Promise.all([a, b, c])

		const clearCalls = callLog.filter(c => c === "secureStore.clear")
		expect(clearCalls.length).toBe(1)

		const cancelCalls = callLog.filter(c => c === "transfers.cancelAll")
		expect(cancelCalls.length).toBe(1)

		const chatsCancelCalls = callLog.filter(c => c === "chatsSync.cancel")
		expect(chatsCancelCalls.length).toBe(1)

		const notesCancelCalls = callLog.filter(c => c === "notesSync.cancel")
		expect(notesCancelCalls.length).toBe(1)

		const offlineCancelCalls = callLog.filter(c => c === "offline.cancel")
		expect(offlineCancelCalls.length).toBe(1)
	})

	it("after a logout settles, a subsequent logout is allowed to run fresh", async () => {
		const first = auth.logout()
		await vi.runAllTimersAsync()
		await first

		callLog.length = 0

		const second = auth.logout()
		await vi.runAllTimersAsync()
		await second

		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offline.cancel")
	})

	it("continues even when audio.stop throws", async () => {
		const audio = await import("@/lib/audio")
		vi.mocked(audio.default.stop).mockRejectedValueOnce(new Error("audio session busy"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("unregisterBackgroundSync")
		expect(callLog).toContain("fileProvider.disable")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offline.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})

	it("continues even when unregisterBackgroundSync throws", async () => {
		const bg = await import("@/lib/backgroundTask")
		vi.mocked(bg.unregisterBackgroundSync).mockRejectedValueOnce(new Error("task manager unavailable"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("audio.stop")
		expect(callLog).toContain("fileProvider.disable")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offline.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})
})
