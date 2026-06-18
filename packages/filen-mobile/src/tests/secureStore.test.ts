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
import { fs, File, setMtime, clearMtimes } from "@/tests/mocks/expoFileSystem"
import { isAvailableAsync, getItemAsync, setItemAsync, AFTER_FIRST_UNLOCK } from "@/tests/mocks/expoSecureStore"
import { mockMmkv } from "@/tests/mocks/reactNativeMMKV"

// Audit B1 (2026-06-11): every keychain WRITE of the encryption key must carry
// kSecAttrAccessibleAfterFirstUnlock — the expo-secure-store default (WhenUnlocked) made the
// key unreadable while the device is locked, killing every locked-device background run.
const ENCRYPTION_KEY_KEYCHAIN_OPTIONS = { keychainAccessible: AFTER_FIRST_UNLOCK }

type SecureStoreInstance = any

const SecureStoreCtor = secureStore.constructor as new () => SecureStoreInstance

function createSecureStore(): SecureStoreInstance {
	return new SecureStoreCtor()
}

/**
 * Captures the encryption key written to ExpoSecureStore during a store.init() call.
 * More robust than indexing mock.calls[0] because it captures the key at call time,
 * insulating the test from any previous calls that may not have been fully cleared.
 * Fresh keys are generated under the AFU-named item (audit B1 revision).
 */
function captureEncryptionKey(): Promise<string> {
	return new Promise(resolve => {
		const original = setItemAsync.getMockImplementation()

		setItemAsync.mockImplementationOnce(async (k: string, v: string) => {
			if (k === "encryptionKeyAfu") {
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
	clearMtimes()
	mockSecureStoreMap.clear()
	mockEvents.emit.mockClear()
	mockEvents.subscribe.mockClear()
	isAvailableAsync.mockClear().mockResolvedValue(true)
	getItemAsync.mockClear().mockResolvedValue(null)
	setItemAsync.mockClear().mockResolvedValue(undefined)
	mockMmkv.getString.mockClear().mockReturnValue(undefined)
	mockMmkv.getBoolean.mockClear().mockReturnValue(undefined)
	mockMmkv.set.mockClear()
	mockMmkv.remove.mockClear()
})

describe("SecureStore", () => {
	describe("getDatabaseEncryptionKey", () => {
		it("derives a deterministic 64-hex subkey, distinct from the root key and unique per root key", async () => {
			const store = createSecureStore()

			getItemAsync.mockResolvedValue("a".repeat(64))

			const dbKey1 = await store.getDatabaseEncryptionKey()
			const dbKey2 = await store.getDatabaseEncryptionKey()

			// 256-bit hex passphrase
			expect(dbKey1).toMatch(/^[0-9a-f]{64}$/)
			// deterministic — the DB must stay readable across relaunches without storing a second secret
			expect(dbKey2).toBe(dbKey1)
			// key separation — never the raw secureStore root key
			expect(dbKey1).not.toBe("a".repeat(64))

			// a different root key derives a different DB key (the derivation depends on the root key)
			const freshStore = createSecureStore()

			getItemAsync.mockResolvedValue("b".repeat(64))

			const dbKeyOther = await freshStore.getDatabaseEncryptionKey()

			expect(dbKeyOther).not.toBe(dbKey1)
		})
	})

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

			expect(setItemAsync).toHaveBeenCalledWith("encryptionKeyAfu", expect.any(String), ENCRYPTION_KEY_KEYCHAIN_OPTIONS)
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

			expect(setItemAsync).toHaveBeenCalledWith("encryptionKeyAfu", expect.stringMatching(/^[0-9a-f]{64}$/), ENCRYPTION_KEY_KEYCHAIN_OPTIONS)
		})

		it("never reads the pre-rename 'encryptionKey' item (its class is frozen at WhenUnlocked — a fresh key under the new name is correct)", async () => {
			// Keychain items keep their accessibility class forever (SecItemUpdate carries only
			// kSecValueData in expo-secure-store), which is WHY the key name changed once.
			// Pre-prod: old installs re-login instead of migrating.
			getItemAsync.mockImplementation(async (k: string) => (k === "encryptionKey" ? "b".repeat(64) : null))

			const store = createSecureStore()

			await store.init()

			expect(getItemAsync).not.toHaveBeenCalledWith("encryptionKey")
			expect(setItemAsync).toHaveBeenCalledWith(
				"encryptionKeyAfu",
				expect.not.stringContaining("b".repeat(64)),
				ENCRYPTION_KEY_KEYCHAIN_OPTIONS
			)
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

			expect(mockMmkv.set).toHaveBeenCalledWith("encryptionKeyAfu", expect.stringMatching(/^[0-9a-f]{64}$/))
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
		const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"

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

		it("deletes orphaned .securestore.bak.* / .securestore.tmp.* siblings (logout is a wipe)", async () => {
			const store = createSecureStore()

			await store.init()
			await store.set("client", "value")

			const dirUri = "file:///shared/group.io.filen.app/secureStore/v1"
			const orphanBackupUri = `${dirUri}/.securestore.bak.crash-uuid`
			const orphanTmpUri = `${dirUri}/.securestore.tmp.crash-uuid`

			// Simulate a write() that hard-crashed mid-swap: an intact prior-credentials backup and a
			// half-written tmp both survive on disk alongside the live destination.
			fs.set(orphanBackupUri, fs.get(fileUri) as Uint8Array)
			fs.set(orphanTmpUri, new Uint8Array([0, 1, 2]))

			await store.clear()

			// clear() must wipe ALL on-disk secret material — destination AND every staging sibling.
			expect(fs.has(fileUri)).toBe(false)
			expect(fs.has(orphanBackupUri)).toBe(false)
			expect(fs.has(orphanTmpUri)).toBe(false)
		})

		it("a surviving backup does not resurrect wiped credentials on the next launch (get path)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client-with-master-keys")

			const encryptionKey = await keyCapture
			const dirUri = "file:///shared/group.io.filen.app/secureStore/v1"
			const orphanBackupUri = `${dirUri}/.securestore.bak.crash-uuid`

			// An intact backup of the credentials survives a prior interrupted write.
			fs.set(orphanBackupUri, fs.get(fileUri) as Uint8Array)

			// User logs out: clear() must wipe the destination AND the orphaned backup.
			await store1.clear()

			expect(fs.has(orphanBackupUri)).toBe(false)

			// Next launch: a fresh instance with the SAME key must NOT recover the wiped credentials.
			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			expect(await store2.get("client")).toBeNull()
			expect(fs.has(fileUri)).toBe(false)
		})

		it("a surviving backup does not resurrect wiped credentials on the next launch (init path)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client-with-master-keys")
			await store1.set("fileProvider", true)

			const encryptionKey = await keyCapture
			const dirUri = "file:///shared/group.io.filen.app/secureStore/v1"
			const orphanBackupUri = `${dirUri}/.securestore.bak.crash-uuid`

			fs.set(orphanBackupUri, fs.get(fileUri) as Uint8Array)

			await store1.clear()

			getItemAsync.mockResolvedValue(encryptionKey)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await store2.init()

			// init() must initialize an EMPTY store — no key is re-emitted from a resurrected backup.
			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toHaveLength(0)
			expect(await store2.get("client")).toBeNull()
			expect(await store2.get("fileProvider")).toBeNull()
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

	describe("undecryptable store: recover from backup, else reset — never brick (supersedes the finding-51 throw-forever)", () => {
		const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"

		// Spec change (2026-06-12, user-approved): a GCM auth-tag failure is DETERMINISTIC —
		// retrying can never succeed, so the old reject-forever behavior was a permanent
		// brick (setup-failed retry loop) for disk corruption, key rotation, or restore
		// mixing. The recovery ladder is: newest valid same-key .bak (zero loss for the
		// interrupted-write case) → fresh empty store (one-time re-login; the cloud is the
		// source of truth). Only TRANSIENT IO failures still throw and preserve the file —
		// that is the surviving core of finding 51 (see the IO test below).

		it("a corrupt destination with a VALID same-key backup recovers the newest good state (zero loss)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client-with-master-keys")
			await store1.set("fileProvider", true)

			const encryptionKey = await keyCapture
			const intactBytes = fs.get(fileUri) as Uint8Array

			expect(intactBytes).toBeInstanceOf(Uint8Array)

			// An interrupted write's surviving backup holds the intact payload...
			fs.set("file:///shared/group.io.filen.app/secureStore/v1/.securestore.bak.recovery", intactBytes)

			// ...while the destination got corrupted (flip a ciphertext byte → auth tag fails).
			const corruptedBytes = new Uint8Array(intactBytes)

			corruptedBytes[20] = (corruptedBytes[20] ?? 0) ^ 0xff
			fs.set(fileUri, corruptedBytes)

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()

			// Every secret recovered from the backup; the destination is the intact payload again.
			expect(await store2.get("client")).toBe("stringified-client-with-master-keys")
			expect(await store2.get("fileProvider")).toBe(true)
			expect(fs.get(fileUri)).toEqual(intactBytes)
		})

		it("set() on a corrupt store with NO valid backup heals and writes a fresh store (no reject-forever)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client-with-master-keys")

			const encryptionKey = await keyCapture
			const intactBytes = fs.get(fileUri) as Uint8Array
			const corruptedBytes = new Uint8Array(intactBytes)

			corruptedBytes[20] = (corruptedBytes[20] ?? 0) ^ 0xff
			fs.set(fileUri, corruptedBytes)

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await expect(store2.set("fresh", "value")).resolves.not.toThrow()

			expect(await store2.get("fresh")).toBe("value")
			// The dead payload is gone — the store was rebuilt fresh, not merged with garbage.
			expect(await store2.get("client")).toBeNull()
		})

		it("init() on a corrupt store with NO valid backup initializes empty and deletes the dead file (re-login, not brick)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")

			const encryptionKey = await keyCapture
			const intactBytes = fs.get(fileUri) as Uint8Array
			const corruptedBytes = new Uint8Array(intactBytes)

			corruptedBytes[18] = (corruptedBytes[18] ?? 0) ^ 0xff
			fs.set(fileUri, corruptedBytes)

			getItemAsync.mockResolvedValue(encryptionKey)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()

			// Empty init: no stored keys to re-emit, dead file removed from disk.
			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toHaveLength(0)
			expect(fs.get(fileUri)).toBeUndefined()
		})

		it("a TRANSIENT IO read failure still throws and leaves the file untouched (the surviving finding-51 core)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")

			const encryptionKey = await keyCapture
			const intactBytes = fs.get(fileUri) as Uint8Array

			getItemAsync.mockResolvedValue(encryptionKey)

			const bytesSyncSpy = vi.spyOn(File.prototype, "bytesSync").mockImplementationOnce(() => {
				throw new Error("EIO: transient read failure")
			})

			try {
				const store2 = createSecureStore()

				// IO failures are not crypto verdicts — no heal, no recovery, just propagate so
				// the next attempt retries against the intact file.
				await expect(store2.init()).rejects.toThrow("EIO")

				expect(fs.get(fileUri)).toEqual(intactBytes)
			} finally {
				bytesSyncSpy.mockRestore()
			}
		})

		it("ORPHANED store (key renamed/lost → fresh generation) self-heals to empty instead of bricking", async () => {
			// A key rename or keychain loss means getEncryptionKey() generates a FRESH key —
			// which provably can never decrypt any pre-existing payload (and no backup
			// validates either). The recovery ladder lands on the empty-store reset.
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")

			await keyCapture

			expect(fs.get(fileUri)).toBeInstanceOf(Uint8Array)

			// New session: the keychain has NO key under the (renamed) name → fresh generation.
			getItemAsync.mockResolvedValue(null)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()

			// The dead payload is gone, the store is empty and fully functional again.
			expect(fs.get(fileUri)).toBeUndefined()
			expect(await store2.get("client")).toBeNull()

			await expect(store2.set("fresh", "value")).resolves.not.toThrow()
			expect(await store2.get("fresh")).toBe("value")
		})

		it("ORPHANED store heals ACROSS BOOTS (key FOUND in the keychain but from a different era)", async () => {
			// The cross-boot brick that was hit live: a prior boot generated + persisted a
			// fresh key, then failed before anything was rewritten — the next boot FINDS
			// that key, and the store from the old era can never decrypt under it. The
			// recovery ladder needs no provenance tracking: decrypt fails, no backup
			// validates, reset to empty.
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")

			await keyCapture

			const foreignKey = "f".repeat(64)

			getItemAsync.mockResolvedValue(foreignKey)

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()
			expect(fs.get(fileUri)).toBeUndefined()
			expect(await store2.get("client")).toBeNull()
		})

		it("ORPHANED store heals on the MMKV-fallback path too (fresh fallback key + pre-existing payload)", async () => {
			const store1 = createSecureStore()

			await store1.init()
			await store1.set("client", "stringified-client")

			expect(fs.get(fileUri)).toBeInstanceOf(Uint8Array)

			// Fallback path with an empty MMKV → fresh generation there.
			isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue(undefined)

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()
			expect(fs.get(fileUri)).toBeUndefined()
			expect(await store2.get("client")).toBeNull()
		})

		it("a genuinely-absent file still initializes empty (absence is not a failure)", async () => {
			// No prior writes — the destination file never exists.
			const store = createSecureStore()

			mockEvents.emit.mockClear()

			await expect(store.init()).resolves.not.toThrow()

			// An empty store: a missing key returns null, and a set then succeeds.
			expect(await store.get("missing")).toBeNull()

			await expect(store.set("first", "value")).resolves.not.toThrow()
			expect(await store.get("first")).toBe("value")
		})

		it("get() still degrades to null on an unreadable file (non-destructive read path)", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")

			const encryptionKey = await keyCapture
			const intactBytes = fs.get(fileUri) as Uint8Array

			getItemAsync.mockResolvedValue(encryptionKey)

			// Init against the valid file so the store is warm (initDone), then corrupt the file and
			// drop the warm cache to force get() down its degrading read() path (not init()).
			const store2 = createSecureStore()

			await store2.init()

			const corruptedBytes = new Uint8Array(intactBytes)

			corruptedBytes[16] = (corruptedBytes[16] ?? 0) ^ 0xff
			fs.set(fileUri, corruptedBytes)
			store2.readCache = null

			// get() never throws — under the recovery ladder the corrupt, backup-less store
			// heals to empty during the read, so the value is null and the dead file is gone.
			const value = await store2.get("client")

			expect(value).toBeNull()
			expect(fs.get(fileUri)).toBeUndefined()
		})
	})

	describe("crash-recovery from orphaned backup (finding 52)", () => {
		const fileUri = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"
		const dirUri = "file:///shared/group.io.filen.app/secureStore/v1"

		/**
		 * Simulates the write() hard-crash window: the live store has been moved aside to a
		 * UUID-named .securestore.bak.* sibling and the destination has not yet been re-created.
		 * Returns the backup uri.
		 */
		function simulateCrashedWriteBackup(): string {
			const intactBytes = fs.get(fileUri) as Uint8Array

			expect(intactBytes).toBeInstanceOf(Uint8Array)

			const backupUri = `${dirUri}/.securestore.bak.crash-uuid`

			fs.set(backupUri, intactBytes)
			fs.delete(fileUri)

			return backupUri
		}

		it("read() recovers data from an orphaned backup when the destination is missing", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client-with-master-keys")
			await store1.set("language", "en")

			const encryptionKey = await keyCapture

			const backupUri = simulateCrashedWriteBackup()

			expect(fs.has(fileUri)).toBe(false)
			expect(fs.has(backupUri)).toBe(true)

			// A fresh instance with the correct key must recover from the backup.
			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			expect(await store2.get("client")).toBe("stringified-client-with-master-keys")
			expect(await store2.get("language")).toBe("en")

			// The recovered payload is promoted back into the canonical destination.
			expect(fs.has(fileUri)).toBe(true)
		})

		it("init() recovers and re-emits every key from an orphaned backup", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "stringified-client")
			await store1.set("fileProvider", true)

			const encryptionKey = await keyCapture

			simulateCrashedWriteBackup()

			getItemAsync.mockResolvedValue(encryptionKey)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await store2.init()

			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "client", value: "stringified-client" }])
			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "fileProvider", value: true }])

			// Destination restored from the backup.
			expect(fs.has(fileUri)).toBe(true)
		})

		it("discards a corrupt backup that fails to decrypt and reports an empty store", async () => {
			// No prior write: only an undecryptable backup exists alongside a missing destination.
			const store = createSecureStore()
			const keyCapture = captureEncryptionKey()

			// Trigger key generation so the store has a stable key, then drop a garbage backup.
			await store.init()

			await keyCapture

			const backupUri = `${dirUri}/.securestore.bak.garbage`

			fs.set(backupUri, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]))

			// The corrupt backup must be ignored (it fails the auth-tag gate) — the store stays empty,
			// no spurious recovery, and the destination is not created from garbage.
			expect(await store.get("anything")).toBeNull()
		})

		it("chooses the NEWEST valid backup by lastModified when several exist", async () => {
			// Produce two DISTINCT valid encrypted payloads under the SAME key by writing the
			// destination twice and snapshotting it each time. Both blobs decrypt with encryptionKey.
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()

			await store1.set("client", "older-credentials")

			const olderBytes = new Uint8Array(fs.get(fileUri) as Uint8Array)

			await store1.set("client", "newer-credentials")

			const newerBytes = new Uint8Array(fs.get(fileUri) as Uint8Array)

			const encryptionKey = await keyCapture

			// Drop both as orphaned backups with DIFFERING mtimes and remove the destination, simulating
			// two interrupted writes whose backups both survived. The older blob is pinned with the
			// later mtime to prove selection is driven by lastModified, not insertion/enumeration order.
			fs.delete(fileUri)

			const newerBackupUri = `${dirUri}/.securestore.bak.newer`
			const olderBackupUri = `${dirUri}/.securestore.bak.older`

			fs.set(newerBackupUri, newerBytes)
			fs.set(olderBackupUri, olderBytes)

			// Newest-by-mtime is the one holding "newer-credentials".
			setMtime(newerBackupUri, 2_000)
			setMtime(olderBackupUri, 1_000)

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			// The newest valid backup wins regardless of which was placed first.
			expect(await store2.get("client")).toBe("newer-credentials")
			expect(fs.has(fileUri)).toBe(true)
		})

		it("falls back to the next-newest valid backup when the newest one is corrupt", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "valid-older-credentials")

			const validBytes = new Uint8Array(fs.get(fileUri) as Uint8Array)
			const encryptionKey = await keyCapture

			fs.delete(fileUri)

			const corruptNewerUri = `${dirUri}/.securestore.bak.corrupt-newer`
			const validOlderUri = `${dirUri}/.securestore.bak.valid-older`

			// The newest backup is garbage (fails the AES-256-GCM auth-tag gate); the older one is valid.
			fs.set(corruptNewerUri, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]))
			fs.set(validOlderUri, validBytes)

			setMtime(corruptNewerUri, 5_000)
			setMtime(validOlderUri, 1_000)

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			// Newest-first ordering tries the corrupt blob, discards it, and recovers the valid older one.
			expect(await store2.get("client")).toBe("valid-older-credentials")
			expect(fs.has(fileUri)).toBe(true)
		})

		it("prefers a present+valid destination and cleans up stale backups", async () => {
			const store1 = createSecureStore()
			const keyCapture = captureEncryptionKey()

			await store1.init()
			await store1.set("client", "current-value")

			const encryptionKey = await keyCapture

			// A stale backup sibling coexists with a valid destination (e.g. an orphaned backup from a
			// prior interrupted write that nonetheless completed).
			const staleBackupUri = `${dirUri}/.securestore.bak.stale`
			const staleTmpUri = `${dirUri}/.securestore.tmp.stale`

			fs.set(staleBackupUri, fs.get(fileUri) as Uint8Array)
			fs.set(staleTmpUri, new Uint8Array([0, 1, 2]))

			getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			// Reads the live destination, not the stale backup.
			expect(await store2.get("client")).toBe("current-value")

			// After a confirmed-valid destination read, stale siblings are opportunistically cleaned.
			expect(fs.has(staleBackupUri)).toBe(false)
			expect(fs.has(staleTmpUri)).toBe(false)
			expect(fs.has(fileUri)).toBe(true)
		})
	})
})
