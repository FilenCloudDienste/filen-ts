import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const {
	callLog,
	mockFromStringified,
	mockLogin,
	mockRegister,
	mockStartPasswordReset,
	mockResendRegistrationConfirmation,
	mockFromConfig
} = vi.hoisted(() => {
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	const mockFromStringified = vi.fn()
	const mockLogin = vi.fn()
	const mockRegister = vi.fn()
	const mockStartPasswordReset = vi.fn()
	const mockResendRegistrationConfirmation = vi.fn()
	const mockFromConfig = vi.fn(() => ({
		fromStringified: mockFromStringified,
		login: mockLogin,
		register: mockRegister,
		startPasswordReset: mockStartPasswordReset,
		resendRegistrationConfirmation: mockResendRegistrationConfirmation
	}))

	return {
		callLog: [] as string[],
		mockFromStringified,
		mockLogin,
		mockRegister,
		mockStartPasswordReset,
		mockResendRegistrationConfirmation,
		mockFromConfig
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/sdk-rs", () => ({
	UnauthJsClient: {
		fromConfig: mockFromConfig
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

vi.mock("@/features/notes/components/sync", () => ({
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
	authedClient: unknown
	unauthedClient: unknown
	clientsReady: Promise<void>
	clientsReadyResolve: (() => void) | null
}

function authInternals(): AuthInternals {
	return auth as unknown as AuthInternals
}

function resetAuthClients(): void {
	const internals = authInternals()

	internals.authedClient = null
	internals.unauthedClient = null
	internals.logoutPromise = null
	// Reset the clientsReady promise so getSdkClients can wait on a fresh one
	let resolve: (() => void) | null = null
	internals.clientsReady = new Promise<void>(r => {
		resolve = r
	})
	internals.clientsReadyResolve = resolve
}

beforeEach(() => {
	callLog.length = 0
	authInternals().logoutPromise = null
	vi.useFakeTimers()
	vi.clearAllMocks()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("auth.logout", () => {
	it("runs the teardown in the documented phase order", async () => {
		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		// Phase 1: parallel — just verify all three are present, no inter-ordering guaranteed
		expect(callLog).toContain("unregisterBackgroundSync")
		expect(callLog).toContain("audio.stop")
		expect(callLog).toContain("fileProvider.disable")

		// Phase 2: serial cancel block — must all follow phase 1 items
		const phase1End = Math.max(
			callLog.indexOf("unregisterBackgroundSync"),
			callLog.indexOf("audio.stop"),
			callLog.indexOf("fileProvider.disable")
		)
		const transfersIdx = callLog.indexOf("transfers.cancelAll")
		const chatsIdx = callLog.indexOf("chatsSync.cancel")
		const notesIdx = callLog.indexOf("notesSync.cancel")
		const offlineIdx = callLog.indexOf("offline.cancel")

		expect(transfersIdx).toBeGreaterThan(phase1End)
		expect(chatsIdx).toBeGreaterThan(transfersIdx)
		expect(notesIdx).toBeGreaterThan(chatsIdx)
		expect(offlineIdx).toBeGreaterThan(notesIdx)

		// Phase 3: storage clear — must follow all cancels
		const secureClearIdx = callLog.indexOf("secureStore.clear")

		expect(secureClearIdx).toBeGreaterThan(offlineIdx)

		// Phase 4: reload — must follow storage clear (fire-and-forget, but mock is sync)
		const reloadIdx = callLog.indexOf("reloadAppAsync")

		expect(reloadIdx).toBeGreaterThan(secureClearIdx)
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

	it("continues even when fileProvider.disable throws", async () => {
		const fp = await import("@/lib/fileProvider")

		vi.mocked(fp.default.disable).mockRejectedValueOnce(new Error("provider unavailable"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("unregisterBackgroundSync")
		expect(callLog).toContain("audio.stop")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offline.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})
})

describe("auth.isAuthed", () => {
	beforeEach(async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.get).mockReset()
	})

	it("returns {isAuthed: false} when secureStore returns null", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.get).mockResolvedValueOnce(null)

		const result = await auth.isAuthed()

		expect(result).toEqual({ isAuthed: false })
	})

	it("returns {isAuthed: true, stringifiedClient} when secureStore returns a value", async () => {
		const secureStore = await import("@/lib/secureStore")
		const fakeClient = { apiKey: "abc", email: "user@example.com", masterKeys: [] }

		vi.mocked(secureStore.default.get).mockResolvedValueOnce(fakeClient)

		const result = await auth.isAuthed()

		expect(result).toEqual({ isAuthed: true, stringifiedClient: fakeClient })
	})
})

describe("auth.saveStringifiedClientToSecureStorage", () => {
	it("persists the client with maxIoMemoryUsage and maxParallelRequests overrides", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const base = { apiKey: "key-1", email: "user@example.com", masterKeys: ["mk1"] } as any

		await auth.saveStringifiedClientToSecureStorage(base)

		expect(vi.mocked(secureStore.default.set)).toHaveBeenCalledWith("stringifiedClient", {
			...base,
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		})
	})

	it("overrides maxIoMemoryUsage and maxParallelRequests even when provided in base object", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const base = { apiKey: "key-2", maxIoMemoryUsage: 1, maxParallelRequests: 1 } as any

		await auth.saveStringifiedClientToSecureStorage(base)

		const firstCall = vi.mocked(secureStore.default.set).mock.calls[0]

		if (!firstCall) {
			throw new Error("expected a call to secureStore.set")
		}

		const [, saved] = firstCall

		expect((saved as any).maxIoMemoryUsage).toBe(auth.maxIoMemoryUsage)
		expect((saved as any).maxParallelRequests).toBe(auth.maxParallelRequests)
	})
})

describe("auth.setSdkClients", () => {
	beforeEach(() => {
		resetAuthClients()
		mockFromStringified.mockReset()
		mockFromConfig.mockClear()
	})

	it("stores authed and unauthed clients and returns them", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const fakeAuthed = { toStringified: vi.fn() }

		mockFromStringified.mockReturnValue(fakeAuthed)

		const stringifiedClient = { apiKey: "ak", email: "x@y.z" } as any
		const result = await auth.setSdkClients(stringifiedClient)

		expect(result.authedClient).toBe(fakeAuthed)
		expect(result.unauthedClient).toBeDefined()
	})

	it("calls saveStringifiedClientToSecureStorage with correct spread", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const fakeAuthed = { toStringified: vi.fn() }

		mockFromStringified.mockReturnValue(fakeAuthed)

		const base = { apiKey: "ak2", email: "a@b.c" } as any

		await auth.setSdkClients(base)

		expect(vi.mocked(secureStore.default.set)).toHaveBeenCalledWith("stringifiedClient", {
			...base,
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		})
	})

	it("passes maxIoMemoryUsage and maxParallelRequests into fromStringified", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		mockFromStringified.mockReturnValue({ toStringified: vi.fn() })

		const base = { apiKey: "ak3" } as any

		await auth.setSdkClients(base)

		expect(mockFromStringified).toHaveBeenCalledWith({
			...base,
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		})
	})

	it("resolves getSdkClients() waiters after setSdkClients completes", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const fakeAuthed = { toStringified: vi.fn() }

		mockFromStringified.mockReturnValue(fakeAuthed)

		const waiter = auth.getSdkClients()

		await auth.setSdkClients({ apiKey: "ak4" } as any)

		const { authedSdkClient } = await waiter

		expect(authedSdkClient).toBe(fakeAuthed)
	})
})

describe("auth.getSdkClients", () => {
	beforeEach(() => {
		resetAuthClients()
	})

	it("returns clients immediately when already initialized", async () => {
		const fakeAuthed = { toStringified: vi.fn() }
		const fakeUnauthed = { fromStringified: vi.fn() }
		const internals = authInternals()

		internals.authedClient = fakeAuthed
		internals.unauthedClient = fakeUnauthed

		const result = await auth.getSdkClients()

		expect(result.authedSdkClient).toBe(fakeAuthed)
		expect(result.unauthedSdkClient).toBe(fakeUnauthed)
	})

	it("throws when clientsReady resolves but clients are still null", async () => {
		const internals = authInternals()

		// Replace with an already-resolved promise so getSdkClients() immediately passes the await
		internals.clientsReady = Promise.resolve()

		await expect(auth.getSdkClients()).rejects.toThrow("SDK clients not initialized after clientsReady resolved")
	})
})

describe("auth.login", () => {
	beforeEach(async () => {
		resetAuthClients()
		mockLogin.mockReset()

		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockReset()
	})

	it("returns the authed client on success", async () => {
		const fakeStringified = { apiKey: "login-key", email: "u@v.w" } as any
		const fakeAuthed = {
			toStringified: vi.fn().mockResolvedValue(fakeStringified)
		}
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)
		mockLogin.mockResolvedValue(fakeAuthed)

		const result = await auth.login({ email: "u@v.w", password: "password123", twoFactorCode: "" })

		expect(result).toBe(fakeAuthed)
	})

	it("saves the stringified client with maxIoMemoryUsage and maxParallelRequests", async () => {
		const fakeStringified = { apiKey: "login-key2", email: "u2@v.w" } as any
		const fakeAuthed = {
			toStringified: vi.fn().mockResolvedValue(fakeStringified)
		}
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)
		mockLogin.mockResolvedValue(fakeAuthed)

		await auth.login({ email: "u2@v.w", password: "pass", twoFactorCode: "" })

		expect(vi.mocked(secureStore.default.set)).toHaveBeenCalledWith("stringifiedClient", {
			...fakeStringified,
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		})
	})

	it("throws when login returns null (null authedClient guard)", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)
		mockLogin.mockResolvedValue(null)

		await expect(auth.login({ email: "u@v.w", password: "pass", twoFactorCode: "" })).rejects.toThrow("Login failed, authed client is null")
	})

	it("resolves getSdkClients() waiters after login succeeds", async () => {
		const fakeStringified = { apiKey: "login-key3" } as any
		const fakeAuthed = {
			toStringified: vi.fn().mockResolvedValue(fakeStringified)
		}
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)
		mockLogin.mockResolvedValue(fakeAuthed)

		const waiter = auth.getSdkClients()

		await auth.login({ email: "u@v.w", password: "pass", twoFactorCode: "" })

		const { authedSdkClient } = await waiter

		expect(authedSdkClient).toBe(fakeAuthed)
	})
})

describe("auth.register", () => {
	beforeEach(() => {
		resetAuthClients()
		mockRegister.mockReset()
	})

	it("lazy-initializes unauthedClient and delegates to register", async () => {
		mockRegister.mockResolvedValueOnce(undefined)

		const params = { email: "new@user.com", password: "p1", authVersion: 2 } as any

		await auth.register(params)

		expect(mockRegister).toHaveBeenCalledWith(params)
	})

	it("reuses existing unauthedClient when one is already set", async () => {
		mockFromConfig.mockClear()

		const fakeExisting = {
			fromStringified: vi.fn(),
			login: vi.fn(),
			register: vi.fn().mockResolvedValue(undefined),
			startPasswordReset: vi.fn(),
			resendRegistrationConfirmation: vi.fn()
		}

		// Pre-set unauthedClient to simulate already-initialized state
		authInternals().unauthedClient = fakeExisting

		await auth.register({ email: "x@y.z", password: "p2", authVersion: 2 } as any)

		// fromConfig should NOT have been called again
		expect(mockFromConfig).not.toHaveBeenCalled()
		expect(fakeExisting.register).toHaveBeenCalled()
	})
})

describe("auth.startPasswordReset", () => {
	beforeEach(() => {
		resetAuthClients()
		mockStartPasswordReset.mockReset()
	})

	it("lazy-initializes unauthedClient and delegates to startPasswordReset", async () => {
		mockStartPasswordReset.mockResolvedValueOnce(undefined)

		await auth.startPasswordReset("forgot@me.com")

		expect(mockStartPasswordReset).toHaveBeenCalledWith("forgot@me.com")
	})

	it("reuses existing unauthedClient when one is already set", async () => {
		mockFromConfig.mockClear()

		const fakeExisting = {
			fromStringified: vi.fn(),
			login: vi.fn(),
			register: vi.fn(),
			startPasswordReset: vi.fn().mockResolvedValue(undefined),
			resendRegistrationConfirmation: vi.fn()
		}

		authInternals().unauthedClient = fakeExisting

		await auth.startPasswordReset("forgot@me.com")

		expect(mockFromConfig).not.toHaveBeenCalled()
		expect(fakeExisting.startPasswordReset).toHaveBeenCalledWith("forgot@me.com")
	})
})

describe("auth.resendConfirmationEmail", () => {
	beforeEach(() => {
		resetAuthClients()
		mockResendRegistrationConfirmation.mockReset()
	})

	it("lazy-initializes unauthedClient and delegates to resendRegistrationConfirmation", async () => {
		mockResendRegistrationConfirmation.mockResolvedValueOnce(undefined)

		await auth.resendConfirmationEmail("unconfirmed@me.com")

		expect(mockResendRegistrationConfirmation).toHaveBeenCalledWith("unconfirmed@me.com")
	})

	it("reuses existing unauthedClient when one is already set", async () => {
		mockFromConfig.mockClear()

		const fakeExisting = {
			fromStringified: vi.fn(),
			login: vi.fn(),
			register: vi.fn(),
			startPasswordReset: vi.fn(),
			resendRegistrationConfirmation: vi.fn().mockResolvedValue(undefined)
		}

		authInternals().unauthedClient = fakeExisting

		await auth.resendConfirmationEmail("unconfirmed@me.com")

		expect(mockFromConfig).not.toHaveBeenCalled()
		expect(fakeExisting.resendRegistrationConfirmation).toHaveBeenCalledWith("unconfirmed@me.com")
	})
})
