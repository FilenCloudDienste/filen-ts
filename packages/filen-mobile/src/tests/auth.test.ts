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
	FilenSdkError: class FilenSdkError extends Error {}
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		remove: vi.fn(async (key: string) => {
			callLog.push(`secureStore.remove:${key}`)
		}),
		get: vi.fn(async () => null),
		set: vi.fn(async () => undefined),
		clear: vi.fn(async () => undefined)
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

let cacheRootUuid: string | null = "stub-root-uuid"

vi.mock("@/lib/cache", () => ({
	default: {
		clear: vi.fn(() => {
			callLog.push("cache.clear")
		}),
		get rootUuid() {
			return cacheRootUuid
		},
		set rootUuid(v: string | null) {
			cacheRootUuid = v
			callLog.push(`cache.rootUuid=${v === null ? "null" : "set"}`)
		}
	}
}))

vi.mock("@/queries/client", () => ({
	queryClient: {
		clear: vi.fn(() => {
			callLog.push("queryClient.clear")
		})
	},
	queryClientPersisterKv: {
		clear: vi.fn(() => {
			callLog.push("queryClientPersisterKv.clear")
		})
	}
}))

vi.mock("@/lib/sqlite", () => ({
	default: {
		kvAsync: {
			clear: vi.fn(async () => {
				callLog.push("sqlite.kvAsync.clear")
			})
		}
	}
}))

vi.mock("@/lib/offline", () => ({
	default: {
		clearAll: vi.fn(async () => {
			callLog.push("offline.clearAll")
		})
	}
}))

vi.mock("@/lib/thumbnails", () => ({
	default: {
		clear: vi.fn(async () => {
			callLog.push("thumbnails.clear")
		})
	}
}))

vi.mock("@/lib/tmp", () => ({
	sweepTmpDir: vi.fn(() => {
		callLog.push("sweepTmpDir")
	})
}))

import auth from "@/lib/auth"

type AuthInternals = {
	authedClient: { uniffiDestroy: () => void } | null
	unauthedClient: { uniffiDestroy: () => void } | null
	clientsReady: Promise<void>
	logoutPromise: Promise<void> | null
}

function authInternals(): AuthInternals {
	return auth as unknown as AuthInternals
}

beforeEach(() => {
	callLog.length = 0
	cacheRootUuid = "stub-root-uuid"
	authInternals().logoutPromise = null
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("auth.logout", () => {
	it("runs the full teardown in dependency order", async () => {
		authInternals().authedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("authedClient.uniffiDestroy")
			})
		}
		authInternals().unauthedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("unauthedClient.uniffiDestroy")
			})
		}

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		expect(callLog).toEqual([
			"transfers.cancelAll",
			"cameraUpload.cancel",
			"unregisterBackgroundSync",
			"fileProvider.disable",
			"secureStore.remove:stringifiedClient",
			"authedClient.uniffiDestroy",
			"unauthedClient.uniffiDestroy",
			"cache.rootUuid=null",
			"cache.clear",
			"queryClient.clear",
			"queryClientPersisterKv.clear",
			"sqlite.kvAsync.clear",
			"offline.clearAll",
			"thumbnails.clear",
			"sweepTmpDir"
		])
	})

	it("destroys SDK clients only after secureStore.remove resolves", async () => {
		authInternals().authedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("authedClient.uniffiDestroy")
			})
		}
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const remove = callLog.indexOf("secureStore.remove:stringifiedClient")
		const destroy = callLog.indexOf("authedClient.uniffiDestroy")

		expect(remove).toBeGreaterThanOrEqual(0)
		expect(destroy).toBeGreaterThan(remove)
	})

	it("wipes disk surfaces AFTER destroying SDK clients", async () => {
		authInternals().authedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("authedClient.uniffiDestroy")
			})
		}
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const destroy = callLog.indexOf("authedClient.uniffiDestroy")
		const sqlClear = callLog.indexOf("sqlite.kvAsync.clear")
		const offlineClear = callLog.indexOf("offline.clearAll")

		expect(destroy).toBeGreaterThanOrEqual(0)
		expect(sqlClear).toBeGreaterThan(destroy)
		expect(offlineClear).toBeGreaterThan(destroy)
	})

	it("nulls both SDK client refs and resets clientsReady", async () => {
		authInternals().authedClient = { uniffiDestroy: vi.fn() }
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }
		const before = authInternals().clientsReady

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		expect(authInternals().authedClient).toBe(null)
		expect(authInternals().unauthedClient).toBe(null)

		const after = authInternals().clientsReady
		expect(after).not.toBe(before)

		const settled = await Promise.race([after.then(() => "resolved"), Promise.resolve("pending")])
		expect(settled).toBe("pending")
	})

	it("concurrent calls share the same in-flight teardown (Promise guard)", async () => {
		authInternals().authedClient = { uniffiDestroy: vi.fn() }
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const a = auth.logout()
		const b = auth.logout()
		const c = auth.logout()

		await vi.runAllTimersAsync()
		await Promise.all([a, b, c])

		const removeCalls = callLog.filter(c => c === "secureStore.remove:stringifiedClient")
		expect(removeCalls.length).toBe(1)

		const cancelCalls = callLog.filter(c => c === "transfers.cancelAll")
		expect(cancelCalls.length).toBe(1)
	})

	it("after a logout settles, a subsequent logout is allowed to run fresh", async () => {
		authInternals().authedClient = { uniffiDestroy: vi.fn() }
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const first = auth.logout()
		await vi.runAllTimersAsync()
		await first

		callLog.length = 0
		authInternals().authedClient = { uniffiDestroy: vi.fn() }
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const second = auth.logout()
		await vi.runAllTimersAsync()
		await second

		expect(callLog).toContain("secureStore.remove:stringifiedClient")
	})

	it("does not throw when SDK client refs are already null", async () => {
		authInternals().authedClient = null
		authInternals().unauthedClient = null

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("secureStore.remove:stringifiedClient")
	})

	it("continues wiping even when one wipe step throws", async () => {
		authInternals().authedClient = { uniffiDestroy: vi.fn() }
		authInternals().unauthedClient = { uniffiDestroy: vi.fn() }

		const offline = await import("@/lib/offline")
		vi.mocked(offline.default.clearAll).mockRejectedValueOnce(new Error("disk full"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("thumbnails.clear")
		expect(callLog).toContain("sweepTmpDir")
	})

	it("swallows uniffiDestroy errors so wipe phase still runs", async () => {
		authInternals().authedClient = {
			uniffiDestroy: vi.fn(() => {
				throw new Error("rust-side double destroy")
			})
		}
		authInternals().unauthedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("unauthedClient.uniffiDestroy")
			})
		}

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("cache.clear")
		expect(callLog).toContain("sqlite.kvAsync.clear")
		expect(callLog).toContain("sweepTmpDir")
	})
})
