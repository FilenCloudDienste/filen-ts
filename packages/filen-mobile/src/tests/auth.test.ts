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

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		cancelAll: vi.fn(() => {
			callLog.push("transfers.cancelAll")
		})
	}
}))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({
	default: {
		cancel: vi.fn(() => {
			callLog.push("cameraUpload.cancel")
		})
	}
}))

vi.mock("@/features/cameraUpload/cameraUploadState", () => ({
	default: {
		clearForLogout: vi.fn(() => {
			callLog.push("cameraUploadState.clearForLogout")
		})
	}
}))

vi.mock("@/features/chats/components/sync", () => ({
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

// The Offline storage layer has no cancel() — nothing reads an abort signal there anymore; the
// sync orchestrator (offlineSync.cancel) owns in-flight cancellation.
vi.mock("@/features/offline/offline", () => ({
	default: {
		clearAll: vi.fn(async () => {
			callLog.push("offline.clearAll")
		})
	}
}))

vi.mock("@/features/offline/offlineSync", () => ({
	default: {
		cancel: vi.fn(() => {
			callLog.push("offlineSync.cancel")
		})
	}
}))

vi.mock("@/features/cameraUpload/backgroundTask", () => ({
	unregisterBackgroundSync: vi.fn(async () => {
		callLog.push("unregisterBackgroundSync")
	})
}))

vi.mock("@/features/settings/fileProvider", () => ({
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

// sort.ts pulls the i18n/time chain (bare __DEV__ at eval) — stub the logout hook only.
vi.mock("@/lib/sort", () => ({
	clearSortCaches: vi.fn(() => {
		callLog.push("clearSortCaches")
	})
}))

vi.mock("@/lib/cache", () => ({
	default: {
		clear: vi.fn(() => {
			callLog.push("cache.clear")
		})
	}
}))

vi.mock("@/lib/fileCache", () => ({
	default: {
		clear: vi.fn(async () => {
			callLog.push("fileCache.clear")
		})
	}
}))

// Stubbed (like fileCache) so auth.ts's import chain doesn't load the real audioCache —
// it pulls expo-image + expo-file-system, which are unloadable in the node test env.
vi.mock("@/features/audio/audioCache", () => ({
	default: {
		clear: vi.fn(async () => {
			callLog.push("audioCache.clear")
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

vi.mock("@/lib/sandboxCache", () => ({
	default: {
		clear: vi.fn(async () => {
			callLog.push("sandboxCache.clear")
		})
	}
}))

vi.mock("@/lib/logger", () => ({
	default: {
		purge: vi.fn(() => {
			callLog.push("logger.purge")
		}),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}
}))

vi.mock("@/features/audio/audio", () => ({
	default: {
		stop: vi.fn(async () => {
			callLog.push("audio.stop")
		})
	}
}))

vi.mock("@/features/drive/driveSearch", () => ({
	default: {
		init: vi.fn(async () => {}),
		closeActive: vi.fn(async () => {
			callLog.push("driveSearch.closeActive")
		}),
		teardownOnLogout: vi.fn(async () => {
			callLog.push("driveSearch.teardownOnLogout")
		})
	}
}))

vi.mock("@/features/drive/drive", () => ({
	default: {
		resetCachedRootUuid: vi.fn(() => {
			callLog.push("drive.resetCachedRootUuid")
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
	lastStringifiedClient: unknown
}

function authInternals(): AuthInternals {
	return auth as unknown as AuthInternals
}

function resetAuthClients(): void {
	const internals = authInternals()

	internals.authedClient = null
	internals.unauthedClient = null
	internals.logoutPromise = null
	internals.lastStringifiedClient = null
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
		const offlineSyncIdx = callLog.indexOf("offlineSync.cancel")

		expect(transfersIdx).toBeGreaterThan(phase1End)
		expect(chatsIdx).toBeGreaterThan(transfersIdx)
		expect(notesIdx).toBeGreaterThan(chatsIdx)

		// The offline sync orchestrator's in-flight pass is aborted last in the cancel block.
		expect(offlineSyncIdx).toBeGreaterThan(notesIdx)

		// Phase 3: storage clear — must follow all cancels
		const secureClearIdx = callLog.indexOf("secureStore.clear")

		expect(secureClearIdx).toBeGreaterThan(offlineSyncIdx)

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

		const offlineSyncCancelCalls = callLog.filter(c => c === "offlineSync.cancel")

		expect(offlineSyncCancelCalls.length).toBe(1)
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
		expect(callLog).toContain("offlineSync.cancel")
	})

	it("continues even when audio.stop throws", async () => {
		const audio = await import("@/features/audio/audio")

		vi.mocked(audio.default.stop).mockRejectedValueOnce(new Error("audio session busy"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("unregisterBackgroundSync")
		expect(callLog).toContain("fileProvider.disable")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offlineSync.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})

	it("continues even when unregisterBackgroundSync throws", async () => {
		const bg = await import("@/features/cameraUpload/backgroundTask")

		vi.mocked(bg.unregisterBackgroundSync).mockRejectedValueOnce(new Error("task manager unavailable"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("audio.stop")
		expect(callLog).toContain("fileProvider.disable")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offlineSync.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})

	it("continues even when fileProvider.disable throws", async () => {
		const fp = await import("@/features/settings/fileProvider")

		vi.mocked(fp.default.disable).mockRejectedValueOnce(new Error("provider unavailable"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()

		await expect(promise).resolves.toBeUndefined()
		expect(callLog).toContain("unregisterBackgroundSync")
		expect(callLog).toContain("audio.stop")
		expect(callLog).toContain("transfers.cancelAll")
		expect(callLog).toContain("chatsSync.cancel")
		expect(callLog).toContain("notesSync.cancel")
		expect(callLog).toContain("offlineSync.cancel")
		expect(callLog).toContain("secureStore.clear")
		expect(callLog).toContain("sqlite.clearAsync")
		expect(callLog).toContain("reloadAppAsync")
	})

	// #1 — the in-memory cache must be wiped BEFORE the SQLite wipe, and every decrypted-at-rest
	// store must be wiped, so no decrypted metadata survives logout.
	it("clears the in-memory cache before wiping SQLite and wipes all decrypted-at-rest stores", async () => {
		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const cacheClearIdx = callLog.indexOf("cache.clear")
		const sqliteClearIdx = callLog.indexOf("sqlite.clearAsync")

		expect(cacheClearIdx).toBeGreaterThanOrEqual(0)
		expect(sqliteClearIdx).toBeGreaterThan(cacheClearIdx)

		// The session-cached drive root uuid is reset in Phase 5, right after the in-memory cache wipe,
		// so it can't leak into the next account's session.
		const driveResetIdx = callLog.indexOf("drive.resetCachedRootUuid")

		expect(driveResetIdx).toBeGreaterThan(cacheClearIdx)

		// The account-scoped camera-upload ledger is latched in Phase 5, alongside the in-memory cache
		// wipe, so a worker-tail write can't re-insert into the next account's shield.
		const cameraLedgerClearIdx = callLog.indexOf("cameraUploadState.clearForLogout")

		expect(cameraLedgerClearIdx).toBeGreaterThan(cacheClearIdx)

		// All decrypted-at-rest stores are wiped — including the diagnostic logs (file/dir names).
		expect(callLog).toContain("offline.clearAll")
		expect(callLog).toContain("fileCache.clear")
		expect(callLog).toContain("audioCache.clear")
		expect(callLog).toContain("thumbnails.clear")
		expect(callLog).toContain("sandboxCache.clear")

		// logger.purge() runs after the in-memory cache clear and before the SQLite/disk wipe — so it's
		// part of the decrypted-state wipe and can't run after a (Phase 7) reload where it'd never fire.
		const purgeIdx = callLog.indexOf("logger.purge")

		expect(purgeIdx).toBeGreaterThan(cacheClearIdx)
		expect(purgeIdx).toBeLessThan(sqliteClearIdx)
	})

	// #8 — the SDK client handles must be destroyed and nulled, and clientsReady re-armed, so no
	// post-wipe getSdkClients() hands out a client whose persisted credentials were just erased.
	it("destroys + nulls the SDK clients and re-arms clientsReady", async () => {
		const internals = authInternals()
		const authedDestroy = vi.fn()
		const unauthedDestroy = vi.fn()

		internals.authedClient = { uniffiDestroy: authedDestroy }
		internals.unauthedClient = { uniffiDestroy: unauthedDestroy }

		const beforeClientsReady = internals.clientsReady

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		expect(authedDestroy).toHaveBeenCalledTimes(1)
		expect(unauthedDestroy).toHaveBeenCalledTimes(1)
		expect(internals.authedClient).toBeNull()
		expect(internals.unauthedClient).toBeNull()

		// clientsReady was replaced with a fresh promise (re-armed).
		expect(internals.clientsReady).not.toBe(beforeClientsReady)
	})

	// #8 — destroy must happen AFTER the cancellations settle (avoid use-after-destroy) and BEFORE
	// the cache/disk wipe (destroying the authed client tears down the socket that could mutate it).
	it("destroys the SDK clients after cancellations and before the cache wipe", async () => {
		const internals = authInternals()

		internals.authedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("authedClient.uniffiDestroy")
			})
		}
		internals.unauthedClient = {
			uniffiDestroy: vi.fn(() => {
				callLog.push("unauthedClient.uniffiDestroy")
			})
		}

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const offlineSyncCancelIdx = callLog.indexOf("offlineSync.cancel")
		const destroyIdx = callLog.indexOf("authedClient.uniffiDestroy")
		const cacheClearIdx = callLog.indexOf("cache.clear")

		expect(destroyIdx).toBeGreaterThan(offlineSyncCancelIdx)
		expect(cacheClearIdx).toBeGreaterThan(destroyIdx)
	})

	// #8 — a reload rejection must be retried, not swallowed, since the in-memory state is now safe.
	it("retries reloadAppAsync when it rejects", async () => {
		const expo = await import("expo")

		vi.mocked(expo.reloadAppAsync).mockRejectedValueOnce(new Error("reload deferred"))

		const promise = auth.logout()

		await vi.runAllTimersAsync()
		await promise

		const reloadCalls = callLog.filter(c => c === "reloadAppAsync")

		// First attempt rejects (no callLog push), the retry succeeds (pushes once).
		expect(vi.mocked(expo.reloadAppAsync).mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(reloadCalls.length).toBeGreaterThanOrEqual(1)
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

	// Regression: an in-place credential change (changePassword) persists a fresh blob HERE without
	// going through setSdkClients. If lastStringifiedClient isn't synced to the persisted payload, a
	// later warm background setup() re-run sees isEqual=false and REBUILDS the client — destroying
	// the live handle that socket.tsx / http.tsx still hold → "Raw pointer value was null".
	it("syncs lastStringifiedClient to the persisted payload so the setSdkClients fast path recognises it", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const base = { apiKey: "rotated-key", email: "user@example.com", masterKeys: ["mk-new"] } as any

		await auth.saveStringifiedClientToSecureStorage(base)

		expect(authInternals().lastStringifiedClient).toEqual({
			...base,
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		})
	})

	it("does not desync the fingerprint when the persist fails (stays whatever it was)", async () => {
		const secureStore = await import("@/lib/secureStore")

		authInternals().lastStringifiedClient = null
		vi.mocked(secureStore.default.set).mockRejectedValueOnce(new Error("disk full"))

		await expect(auth.saveStringifiedClientToSecureStorage({ apiKey: "k" } as any)).rejects.toThrow("disk full")

		// The write threw before the fingerprint assignment, so disk and fingerprint stay consistent
		// (both un-updated) rather than the fingerprint advancing past what's on disk.
		expect(authInternals().lastStringifiedClient).toBeNull()
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

	// #9 — destroy the prior handles before reassigning so the native Arcs are reclaimed
	// deterministically rather than orphaned for GC finalization.
	it("destroys existing authed + unauthed handles before reassigning", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const priorAuthedDestroy = vi.fn()
		const priorUnauthedDestroy = vi.fn()
		const internals = authInternals()

		internals.authedClient = { uniffiDestroy: priorAuthedDestroy }
		internals.unauthedClient = { uniffiDestroy: priorUnauthedDestroy }

		mockFromStringified.mockReturnValue({ toStringified: vi.fn() })

		await auth.setSdkClients({ apiKey: "ak-replace" } as any)

		expect(priorAuthedDestroy).toHaveBeenCalledTimes(1)
		expect(priorUnauthedDestroy).toHaveBeenCalledTimes(1)
	})

	// Audit B2b (2026-06-11) — a second setup() in the same process (iOS cold background
	// launch runs the task body's setup AND RootLayout's; warm Android re-runs setup per
	// WorkManager fire) reads the SAME stored blob. Reconstructing would uniffiDestroy
	// handles that in-flight work captured via getSdkClients().
	it("same-input second call keeps the live clients — no destroy, no reconstruction", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValue(undefined)

		const authedDestroy = vi.fn()

		mockFromStringified.mockReturnValue({ toStringified: vi.fn(), uniffiDestroy: authedDestroy })

		// The blob a real setup() re-reads from secureStore carries the persisted maxIo/maxParallel
		// overrides (saveStringifiedClientToSecureStorage decorates them), so the fast-path fingerprint
		// keys on that decorated shape. Passing the bare shape would trip the override-migration branch.
		const stored = {
			apiKey: "ak-same",
			email: "x@y.z",
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		} as any

		const first = await auth.setSdkClients(stored)

		const fromConfigCallsAfterFirst = mockFromConfig.mock.calls.length

		// Structurally-equal clone — exactly what a second setup() passes after re-reading
		// the stored client from secureStore.
		const second = await auth.setSdkClients({ ...stored } as any)

		expect(second.authedClient).toBe(first.authedClient)
		expect(second.unauthedClient).toBe(first.unauthedClient)
		expect(authedDestroy).not.toHaveBeenCalled()
		expect(mockFromConfig.mock.calls.length).toBe(fromConfigCallsAfterFirst)
	})

	it("prepareForReload() destroys both live handles and resets client state (login flow calls it before reloadAppAsync)", async () => {
		// uniffi handles have no GC: a JS reload kills the proxies but leaks the Rust Arcs
		// (reqwest pool, tokio resources). The login flow creates a fresh client pair and
		// then reloads — without this, every login leaks the pair.
		const authedDestroy = vi.fn()
		const unauthedDestroy = vi.fn()
		const internals = authInternals()

		internals.authedClient = { uniffiDestroy: authedDestroy }
		internals.unauthedClient = { uniffiDestroy: unauthedDestroy }
		internals.lastStringifiedClient = { apiKey: "ak" }
		;(auth as unknown as { prepareForReload: () => void }).prepareForReload()

		expect(authedDestroy).toHaveBeenCalledTimes(1)
		expect(unauthedDestroy).toHaveBeenCalledTimes(1)
		expect(internals.authedClient).toBeNull()
		expect(internals.unauthedClient).toBeNull()
		expect(internals.lastStringifiedClient).toBeNull()
	})

	it("recoverAfterFailedReload() rebuilds the clients and resolves the re-armed latch (reloadAppAsync threw)", async () => {
		const secureStore = await import("@/lib/secureStore")

		// Credentials are persisted — login committed them before the reload attempt.
		vi.mocked(secureStore.default.get).mockResolvedValue({ apiKey: "ak-persisted" } as never)

		const internals = authInternals()

		internals.authedClient = { uniffiDestroy: vi.fn() }
		internals.unauthedClient = { uniffiDestroy: vi.fn() }
		;(auth as unknown as { prepareForReload: () => void }).prepareForReload()

		// The re-armed latch parks new waiters: without recovery this hangs forever.
		let resolved = false
		const waiter = auth.getSdkClients().then(() => {
			resolved = true
		})

		// Fake timers are active — flush microtasks only (the latch is promise-based).
		await vi.advanceTimersByTimeAsync(0)

		expect(resolved).toBe(false)

		vi.mocked(secureStore.default.set).mockResolvedValue(undefined)
		mockFromStringified.mockReturnValueOnce({ toStringified: vi.fn(), uniffiDestroy: vi.fn() })

		await auth.recoverAfterFailedReload()
		await waiter

		expect(resolved).toBe(true)
		expect(internals.authedClient).not.toBeNull()
		expect(internals.unauthedClient).not.toBeNull()
	})

	it("changed input still reconstructs and destroys the prior handles", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValue(undefined)

		const firstAuthedDestroy = vi.fn()
		const firstUnauthedDestroy = vi.fn()

		mockFromConfig.mockReturnValueOnce({
			fromStringified: mockFromStringified,
			login: mockLogin,
			register: mockRegister,
			startPasswordReset: mockStartPasswordReset,
			resendRegistrationConfirmation: mockResendRegistrationConfirmation,
			uniffiDestroy: firstUnauthedDestroy
		} as unknown as ReturnType<typeof mockFromConfig>)
		mockFromStringified.mockReturnValueOnce({ toStringified: vi.fn(), uniffiDestroy: firstAuthedDestroy })

		const first = await auth.setSdkClients({ apiKey: "ak-one" } as any)

		mockFromStringified.mockReturnValueOnce({ toStringified: vi.fn(), uniffiDestroy: vi.fn() })

		const second = await auth.setSdkClients({ apiKey: "ak-two" } as any)

		expect(firstAuthedDestroy).toHaveBeenCalledTimes(1)
		expect(firstUnauthedDestroy).toHaveBeenCalledTimes(1)
		expect(second.authedClient).not.toBe(first.authedClient)
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

	it("skips the secureStore write when the stored overrides already match the current constants", async () => {
		const secureStore = await import("@/lib/secureStore")

		mockFromStringified.mockReturnValue({ toStringified: vi.fn() })

		const stored = {
			apiKey: "ak-match",
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests
		} as any

		await auth.setSdkClients(stored)

		expect(vi.mocked(secureStore.default.set)).not.toHaveBeenCalled()
	})

	it("writes (migrates) when the stored overrides are absent", async () => {
		const secureStore = await import("@/lib/secureStore")

		mockFromStringified.mockReturnValue({ toStringified: vi.fn() })

		await auth.setSdkClients({ apiKey: "ak-absent" } as any)

		expect(vi.mocked(secureStore.default.set)).toHaveBeenCalledTimes(1)
	})

	it("writes (migrates) when a stored override differs from the current constant", async () => {
		const secureStore = await import("@/lib/secureStore")

		mockFromStringified.mockReturnValue({ toStringified: vi.fn() })

		const stored = {
			apiKey: "ak-diff",
			maxIoMemoryUsage: auth.maxIoMemoryUsage,
			maxParallelRequests: auth.maxParallelRequests + 1
		} as any

		await auth.setSdkClients(stored)

		expect(vi.mocked(secureStore.default.set)).toHaveBeenCalledTimes(1)
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

	// #9 — login() is called repeatedly (wrong password, post-2FA second attempt), so it must destroy
	// the handles it is about to replace.
	it("destroys existing authed + unauthed handles before reassigning", async () => {
		const secureStore = await import("@/lib/secureStore")

		vi.mocked(secureStore.default.set).mockResolvedValueOnce(undefined)

		const priorAuthedDestroy = vi.fn()
		const priorUnauthedDestroy = vi.fn()
		const internals = authInternals()

		internals.authedClient = { uniffiDestroy: priorAuthedDestroy }
		internals.unauthedClient = { uniffiDestroy: priorUnauthedDestroy }

		const fakeAuthed = { toStringified: vi.fn().mockResolvedValue({ apiKey: "k" }) }

		mockLogin.mockResolvedValue(fakeAuthed)

		await auth.login({ email: "u@v.w", password: "pass", twoFactorCode: "" })

		expect(priorAuthedDestroy).toHaveBeenCalledTimes(1)
		expect(priorUnauthedDestroy).toHaveBeenCalledTimes(1)
	})

	// #9 — when login() rejects, the freshly-created unauthed handle is destroyed and nulled so a
	// failed attempt does not orphan a native Arc.
	it("destroys the freshly-created unauthed handle and nulls it when login rejects", async () => {
		const unauthedDestroy = vi.fn()

		mockFromConfig.mockReturnValueOnce({
			fromStringified: mockFromStringified,
			login: vi.fn().mockRejectedValue(new Error("bad password")),
			register: mockRegister,
			startPasswordReset: mockStartPasswordReset,
			resendRegistrationConfirmation: mockResendRegistrationConfirmation,
			uniffiDestroy: unauthedDestroy
		} as any)

		await expect(auth.login({ email: "u@v.w", password: "wrong", twoFactorCode: "" })).rejects.toThrow("bad password")

		const internals = authInternals()

		expect(unauthedDestroy).toHaveBeenCalledTimes(1)
		expect(internals.unauthedClient).toBeNull()
		expect(internals.authedClient).toBeNull()
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

		await expect(auth.login({ email: "u@v.w", password: "pass", twoFactorCode: "" })).rejects.toThrow(
			"Login failed, authed client is null"
		)
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
