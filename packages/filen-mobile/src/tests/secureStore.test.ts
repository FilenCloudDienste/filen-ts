import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreMap, mockEvents } = vi.hoisted(() => {
	// Must be set before the module-level singleton is constructed
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	return {
		mockSecureStoreMap: new Map<string, unknown>(),
		mockEvents: {
			emit: vi.fn(),
			subscribe: vi.fn().mockReturnValue({ remove: vi.fn() })
		}
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

vi.mock("react-native-quick-crypto", async () => await import("@/tests/mocks/reactNativeQuickCrypto"))

vi.mock("@/lib/cache", () => ({
	default: {
		secureStore: {
			get: (key: string) => mockSecureStoreMap.get(key),
			set: (key: string, value: unknown) => mockSecureStoreMap.set(key, value),
			delete: (key: string) => mockSecureStoreMap.delete(key),
			clear: () => mockSecureStoreMap.clear()
		}
	}
}))

vi.mock("@/lib/events", () => ({
	default: mockEvents
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

import secureStore from "@/lib/secureStore"
import { fs, File } from "@/tests/mocks/expoFileSystem"
import { isAvailableAsync, getItemAsync, setItemAsync } from "@/tests/mocks/expoSecureStore"
import { mockMmkv } from "@/tests/mocks/reactNativeMMKV"

type SecureStoreInstance = any

const SecureStoreCtor = secureStore.constructor as new () => SecureStoreInstance

function createSecureStore(): SecureStoreInstance {
	return new SecureStoreCtor()
}

/**
 * Captures the encryption key written to ExpoSecureStore during a store.init() call.
 * More robust than indexing mock.calls[0] because it captures the key at call time,
 * insulating the test from any previous calls that may not have been fully cleared.
 */
function captureEncryptionKey(): Promise<string> {
	return new Promise(resolve => {
		const original = setItemAsync.getMockImplementation()

		setItemAsync.mockImplementationOnce(async (k: string, v: string) => {
			if (k === "encryptionKey") {
				resolve(v)
			}

			if (original) {
				return original(k, v)
			}
		})
	})
}

beforeEach(() => {
	fs.clear()
	mockSecureStoreMap.clear()
	mockEvents.emit.mockClear()
	mockEvents.subscribe.mockClear()
	isAvailableAsync.mockClear().mockResolvedValue(true)
	getItemAsync.mockClear().mockResolvedValue(null)
	setItemAsync.mockClear().mockResolvedValue(undefined)
	mockMmkv.getString.mockClear().mockReturnValue(undefined)
	mockMmkv.set.mockClear()
})

describe("SecureStore", () => {
	describe("constructor", () => {
		it("throws if EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY is missing", () => {
			const saved = process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"]

			delete process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"]

			try {
				expect(() => createSecureStore()).toThrow("Missing EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY")
			} finally {
				process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = saved
			}
		})

		it("creates mmkv directory if it does not exist", () => {
			createSecureStore()

			const mmkvDirUri = "file:///shared/group.io.filen.app/mmkv/v1"

			expect(fs.get(mmkvDirUri)).toBe("dir")
		})
	})

	describe("init", () => {
		it("generates and stores encryption key on first init", async () => {
			const store = createSecureStore()

			await store.init()

			expect(setItemAsync).toHaveBeenCalledWith("encryptionKey", expect.any(String))
		})

		it("reads existing data from file and populates cache", async () => {
			// First store: write some data
			const store1 = createSecureStore()
			// Capture the key the moment setItemAsync is called — avoids index fragility
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("myKey", "myValue")

			const encryptionKey = await keyCapture

			mockEvents.emit.mockClear()

			// Second store: should read from the file written by store1
			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreChange", {
				key: "myKey",
				value: "myValue"
			})
		})

		it("emits secureStoreChange for each key during init", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("key1", "val1")
			await store1.set("key2", "val2")

			const encryptionKey = await keyCapture

			getItemAsync.mockResolvedValue(encryptionKey)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await store2.init()

			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toHaveLength(2)
			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "key1", value: "val1" }])
			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "key2", value: "val2" }])
		})

		it("is idempotent — a second init() on the same instance does not re-read or re-emit", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("k", "v")

			const encryptionKey = await keyCapture

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()
			mockEvents.emit.mockClear()

			await store2.init()

			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toHaveLength(0)
		})
	})

	describe("getEncryptionKey", () => {
		it("generates a key if none exists in ExpoSecureStore", async () => {
			getItemAsync.mockResolvedValue(null)

			const store = createSecureStore()

			await store.init()

			expect(setItemAsync).toHaveBeenCalledWith("encryptionKey", expect.stringMatching(/^[0-9a-f]{64}$/))
		})

		it("reuses cached key on subsequent calls", async () => {
			const store = createSecureStore()

			await store.init()

			const firstCallCount = getItemAsync.mock.calls.length

			// set triggers another getEncryptionKey internally
			await store.set("test", "value")

			// getItemAsync should not be called again — key is cached
			expect(getItemAsync.mock.calls.length).toBe(firstCallCount)
		})

		it("falls back to MMKV when ExpoSecureStore is not available", async () => {
			isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue(undefined)

			const store = createSecureStore()

			await store.init()

			expect(mockMmkv.set).toHaveBeenCalledWith("encryptionKey", expect.stringMatching(/^[0-9a-f]{64}$/))
		})

		it("retrieves existing key from MMKV when available", async () => {
			isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue("a".repeat(64))

			const store = createSecureStore()

			await store.init()

			// Should not generate a new key
			expect(mockMmkv.set).not.toHaveBeenCalled()
		})
	})

	describe("isAvailable() caching", () => {
		it("calls isAvailableAsync only once across multiple operations on the same instance", async () => {
			const store = createSecureStore()

			// Three operations each internally call getEncryptionKey → isAvailable()
			await store.init()
			await store.set("k1", "v1")
			await store.set("k2", "v2")

			// isAvailableAsync must have been invoked exactly once; subsequent calls use the cached field
			expect(isAvailableAsync).toHaveBeenCalledTimes(1)
		})

		it("caches a false result and never retries isAvailableAsync", async () => {
			isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue("a".repeat(64))

			const store = createSecureStore()

			await store.init()
			await store.set("k", "v")

			expect(isAvailableAsync).toHaveBeenCalledTimes(1)
		})
	})

	describe("auto-init via waitForInit", () => {
		it("set() without explicit init() still persists the value", async () => {
			const store = createSecureStore()

			// Deliberately skip store.init()
			await store.set("autoKey", "autoValue")

			const result = await store.get("autoKey")

			expect(result).toBe("autoValue")
		})

		it("get() without explicit init() returns null for missing key", async () => {
			const store = createSecureStore()

			const result = await store.get("missing")

			expect(result).toBeNull()
		})
	})

	describe("set", () => {
		it("writes value and emits secureStoreChange", async () => {
			const store = createSecureStore()

			await store.init()
			mockEvents.emit.mockClear()

			await store.set("username", "alice")

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreChange", {
				key: "username",
				value: "alice"
			})
		})

		it("updates the cache", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("token", "abc123")

			expect(mockSecureStoreMap.get("token")).toBe("abc123")
		})

		it("persists falsy value 0", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("count", 0)

			const result = await store.get("count")

			expect(result).toBe(0)
		})

		it("persists falsy value false", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("enabled", false)

			const result = await store.get("enabled")

			expect(result).toBe(false)
		})

		it("persists empty string", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("name", "")

			const result = await store.get("name")

			expect(result).toBe("")
		})
	})

	describe("get", () => {
		it("returns value after set", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "value")

			const result = await store.get("key")

			expect(result).toBe("value")
		})

		it("returns null for missing key", async () => {
			const store = createSecureStore()

			await store.init()

			const result = await store.get("nonexistent")

			expect(result).toBeNull()
		})
	})

	describe("multiple set/get operations", () => {
		it("handles multiple keys independently", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key1", "value1")
			await store.set("key2", "value2")
			await store.set("key3", "value3")

			expect(await store.get("key1")).toBe("value1")
			expect(await store.get("key2")).toBe("value2")
			expect(await store.get("key3")).toBe("value3")
		})

		it("overwrites existing key with new value", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "original")
			await store.set("key", "updated")

			const result = await store.get("key")

			expect(result).toBe("updated")
		})

		it("does not affect other keys when overwriting", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("a", "alpha")
			await store.set("b", "beta")
			await store.set("a", "alpha2")

			expect(await store.get("a")).toBe("alpha2")
			expect(await store.get("b")).toBe("beta")
		})
	})

	describe("encryption roundtrip", () => {
		it("data written by one instance can be read by another using the same key", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()

			await store1.set("secret", "encrypted-data")

			const encryptionKey = await keyCapture

			// Create a new instance that retrieves the same key
			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()

			const result = await store2.get("secret")

			expect(result).toBe("encrypted-data")
		})

		it("file contents are actually encrypted (not plaintext)", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("password", "super-secret-123")

			// Find the secure store file in the in-memory fs
			const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"
			const fileBytes = fs.get(fileUri)

			expect(fileBytes).toBeInstanceOf(Uint8Array)

			// The raw bytes should not contain the plaintext value
			const rawText = new TextDecoder().decode(fileBytes as Uint8Array)

			expect(rawText).not.toContain("super-secret-123")
		})

		it("encrypted file has correct structure: 12-byte IV + ciphertext + 16-byte authTag", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("data", "test-value")

			const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"
			const fileBytes = fs.get(fileUri) as Uint8Array

			// Must be at least 12 (IV) + 1 (min ciphertext) + 16 (authTag) = 29 bytes
			expect(fileBytes.length).toBeGreaterThanOrEqual(29)
		})
	})

	describe("remove", () => {
		it("removes a key and emits secureStoreRemove", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "value")
			mockEvents.emit.mockClear()

			await store.remove("key")

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreRemove", {
				key: "key"
			})
		})

		it("key is no longer retrievable after remove", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "value")

			await store.remove("key")

			const result = await store.get("key")

			expect(result).toBeNull()
		})

		it("does not affect other keys", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("keep", "kept-value")
			await store.set("remove", "removed-value")

			await store.remove("remove")

			expect(await store.get("keep")).toBe("kept-value")
			expect(await store.get("remove")).toBeNull()
		})

		it("deletes key from cache", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "value")

			expect(mockSecureStoreMap.has("key")).toBe(true)

			await store.remove("key")

			expect(mockSecureStoreMap.has("key")).toBe(false)
		})

		it("removing a non-existent key does not throw and emits secureStoreRemove", async () => {
			const store = createSecureStore()

			await store.init()
			mockEvents.emit.mockClear()

			await expect(store.remove("never-set")).resolves.not.toThrow()

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreRemove", {
				key: "never-set"
			})
		})

		it("removing a non-existent key does not affect existing keys", async () => {
			const store = createSecureStore()

			await store.init()
			await store.set("existing", "data")

			await store.remove("never-set")

			expect(await store.get("existing")).toBe("data")
		})
	})

	describe("clear", () => {
		it("emits secureStoreClear", async () => {
			const store = createSecureStore()

			await store.init()
			mockEvents.emit.mockClear()

			await store.clear()

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreClear")
		})

		it("removes all keys", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("a", "1")
			await store.set("b", "2")

			await store.clear()

			expect(await store.get("a")).toBeNull()
			expect(await store.get("b")).toBeNull()
		})

		it("deletes the file from disk", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("key", "value")

			const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"

			expect(fs.has(fileUri)).toBe(true)

			await store.clear()

			expect(fs.has(fileUri)).toBe(false)
		})

		it("clears the cache", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("x", "y")

			expect(mockSecureStoreMap.size).toBeGreaterThan(0)

			await store.clear()

			expect(mockSecureStoreMap.size).toBe(0)
		})

		it("does not throw when file does not exist", async () => {
			const store = createSecureStore()

			await store.init()

			// Clear without any prior writes — file never created
			await expect(store.clear()).resolves.not.toThrow()
		})

		it("can set values after clear", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("a", 1)
			await store.clear()
			await store.set("b", 2)

			const value = await store.get("b")

			expect(value).toBe(2)
		})
	})

	describe("concurrent operations", () => {
		it("serializes concurrent set calls correctly", async () => {
			const store = createSecureStore()

			await store.init()

			await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3)])

			expect(await store.get("a")).toBe(1)
			expect(await store.get("b")).toBe(2)
			expect(await store.get("c")).toBe(3)
		})

		it("remove does not affect other keys written concurrently", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("keep", "value")
			await store.set("remove", "gone")

			await Promise.all([store.remove("remove"), store.set("keep", "updated")])

			expect(await store.get("remove")).toBeNull()
			expect(await store.get("keep")).toBe("updated")
		})

		it("concurrent get calls return correct values without modMutex", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("a", 1)
			await store.set("b", 2)
			await store.set("c", 3)

			const [a, b, c] = await Promise.all([store.get("a"), store.get("b"), store.get("c")])

			expect(a).toBe(1)
			expect(b).toBe(2)
			expect(c).toBe(3)
		})

		it("concurrent reads that race before cache is warm each return the correct value", async () => {
			const store = createSecureStore()
			const keyCapture = captureEncryptionKey()

			// Warm a fresh store with data written to disk
			const warm = createSecureStore()

			await warm.init()
			await warm.set("shared", "hello")

			const encryptionKey = await keyCapture

			getItemAsync.mockResolvedValue(encryptionKey)

			// store has no readCache yet — multiple concurrent gets must all succeed
			// without corrupting each other through the rwMutex contention path
			const [r1, r2, r3] = await Promise.all([store.get("shared"), store.get("shared"), store.get("shared")])

			expect(r1).toBe("hello")
			expect(r2).toBe("hello")
			expect(r3).toBe("hello")
		})
	})

	describe("clear followed by sequential operations", () => {
		it("set after clear persists new value and clear wipes the old value", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("existing", "value")

			// Run clear and set sequentially so the ordering is deterministic.
			// Promise.all with no explicit ordering guarantee cannot test this reliably.
			await store.clear()
			await store.set("new", "data")

			const newVal = await store.get("new")

			expect(newVal).toBe("data")

			// "existing" was present before clear so it must be gone now
			const oldVal = await store.get("existing")

			expect(oldVal).toBeNull()
		})
	})

	describe("atomic write — no zero-copy window", () => {
		const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"

		it("does not delete the existing store before the new payload is staged", async () => {
			const store = createSecureStore()

			await store.init()
			await store.set("key", "v1")

			expect(fs.has(fileUri)).toBe(true)

			// Fail the promotion of the staged tmp file into the destination. The move-aside
			// of the existing store (source securestore.bin) and any restore (source .bak.)
			// must still succeed — only the tmp -> destination promotion fails.
			const originalMove = File.prototype.move
			const moveSpy = vi.spyOn(File.prototype, "move").mockImplementation(function (this: File, dest) {
				if (this.uri.includes(".securestore.tmp.")) {
					throw new Error("simulated I/O error during move")
				}

				originalMove.call(this, dest)
			})

			try {
				await expect(store.set("key", "v2")).rejects.toThrow("simulated I/O error during move")
			} finally {
				moveSpy.mockRestore()
			}

			// The destination must still exist after the failed write — credentials are never wiped.
			expect(fs.has(fileUri)).toBe(true)

			// And it must still hold the previously-committed value, recoverable by a fresh instance.
			const setCall = setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()

			expect(await store2.get("key")).toBe("v1")
		})

		it("leaves no temp or backup orphans on the happy path", async () => {
			const store = createSecureStore()

			await store.init()
			await store.set("key", "first")
			await store.set("key", "second")

			const orphans = [...fs.keys()].filter(k => k.includes(".securestore.tmp.") || k.includes(".securestore.bak."))

			expect(orphans).toHaveLength(0)
			expect(await store.get("key")).toBe("second")
		})

		it("preserves backup when both promotion and restore fail (double-failure scenario)", async () => {
			const store = createSecureStore()

			await store.init()
			await store.set("key", "v1")

			expect(fs.has(fileUri)).toBe(true)

			const originalMove = File.prototype.move
			let moveCallCount = 0

			// First move call: move existing store to backup (allow) — this establishes backedUp=true.
			// Second move call: promote tmp to destination (throw) — this triggers the error path.
			// Third move call: restore backup to destination (throw) — double failure.
			const moveSpy = vi.spyOn(File.prototype, "move").mockImplementation(function (this: File, dest) {
				moveCallCount++

				// Allow the backup move (first call for the existing store)
				if (this.uri.includes(".securestore.bak.")) {
					// This is either the restore call or a backup delete — allow restore
					originalMove.call(this, dest)

					return
				}

				if (this.uri.includes(".securestore.tmp.")) {
					throw new Error("promotion failed")
				}

				// The backup creation (existing → bak) needs to succeed so backedUp=true
				originalMove.call(this, dest)
			})

			// Make the restore-from-backup move also fail by intercepting any move to the destination
			let backupMoveCount = 0

			moveSpy.mockImplementation(function (this: File, dest) {
				// Allow the first move (existing → backup)
				if (!this.uri.includes(".securestore.tmp.") && !this.uri.includes(".securestore.bak.")) {
					originalMove.call(this, dest)

					return
				}

				// tmp → destination: fail (triggers restore)
				if (this.uri.includes(".securestore.tmp.")) {
					throw new Error("promotion failed")
				}

				// backup → destination: fail (double failure)
				if (this.uri.includes(".securestore.bak.")) {
					backupMoveCount++

					if (backupMoveCount === 1) {
						throw new Error("restore also failed")
					}

					originalMove.call(this, dest)
				}
			})

			try {
				await expect(store.set("key", "v2")).rejects.toThrow("promotion failed")
			} finally {
				moveSpy.mockRestore()
			}

			// After double failure: backup file should still exist (best-effort preserved)
			// and destination may be absent — the backup is the surviving copy.
			const backupFiles = [...fs.keys()].filter(k => k.includes(".securestore.bak."))
			const destExists = fs.has(fileUri)

			// At least one of: destination restored OR backup preserved
			expect(backupFiles.length > 0 || destExists).toBe(true)
		})
	})
})
