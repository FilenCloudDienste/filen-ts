import { vi, describe, it, expect, beforeEach } from "vitest"

const { UniffiEnum, mockSecureStoreMap, mockEvents, mockExpoSecureStore, mockMmkv } = vi.hoisted(() => {
	// Must be set before the module-level singleton is constructed
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	const mockSecureStoreMap = new Map<string, unknown>()

	return {
		UniffiEnum: class UniffiEnum {
			protected constructor(..._args: any[]) {}
		},
		mockSecureStoreMap,
		mockEvents: {
			emit: vi.fn(),
			subscribe: vi.fn().mockReturnValue({ remove: vi.fn() })
		},
		mockExpoSecureStore: {
			isAvailableAsync: vi.fn().mockResolvedValue(true),
			getItemAsync: vi.fn().mockResolvedValue(null),
			setItemAsync: vi.fn().mockResolvedValue(undefined)
		},
		mockMmkv: {
			getString: vi.fn().mockReturnValue(undefined),
			set: vi.fn()
		}
	}
})

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-secure-store", () => mockExpoSecureStore)

vi.mock("react-native-mmkv", () => ({
	createMMKV: () => mockMmkv
}))

vi.mock("react-native-quick-crypto", async () => {
	const { Buffer } = await import("buffer")

	return { default: {}, Buffer }
})

vi.mock("react-fast-compare", () => ({
	default: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
}))

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

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

import secureStore from "@/lib/secureStore"
import { fs } from "@/tests/mocks/expoFileSystem"

type SecureStoreInstance = any

const SecureStoreCtor = secureStore.constructor as new () => SecureStoreInstance

function createSecureStore(): SecureStoreInstance {
	return new SecureStoreCtor()
}

beforeEach(() => {
	fs.clear()
	mockSecureStoreMap.clear()
	mockEvents.emit.mockClear()
	mockEvents.subscribe.mockClear()
	mockExpoSecureStore.isAvailableAsync.mockClear().mockResolvedValue(true)
	mockExpoSecureStore.getItemAsync.mockClear().mockResolvedValue(null)
	mockExpoSecureStore.setItemAsync.mockClear().mockResolvedValue(undefined)
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

			const mmkvDirUri = "file:///shared/group.io.filen.app/mmkv"

			expect(fs.get(mmkvDirUri)).toBe("dir")
		})
	})

	describe("init", () => {
		it("generates and stores encryption key on first init", async () => {
			const store = createSecureStore()

			await store.init()

			expect(mockExpoSecureStore.setItemAsync).toHaveBeenCalledWith("encryptionKey.v1", expect.any(String))
		})

		it("reads existing data from file and populates cache", async () => {
			// First store: write some data
			const store1 = createSecureStore()

			await store1.init()
			await store1.set("myKey", "myValue")

			// Get the encryption key that was generated
			const setCall = mockExpoSecureStore.setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			mockEvents.emit.mockClear()

			// Second store: should read from the file written by store1
			mockExpoSecureStore.getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()

			expect(mockEvents.emit).toHaveBeenCalledWith("secureStoreChange", {
				key: "myKey",
				value: "myValue"
			})
		})

		it("emits secureStoreChange for each key during init", async () => {
			const store1 = createSecureStore()

			await store1.init()
			await store1.set("key1", "val1")
			await store1.set("key2", "val2")

			const setCall = mockExpoSecureStore.setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			mockExpoSecureStore.getItemAsync.mockResolvedValue(encryptionKey)
			mockEvents.emit.mockClear()

			const store2 = createSecureStore()

			await store2.init()

			const changeEmits = mockEvents.emit.mock.calls.filter(([event]) => event === "secureStoreChange")

			expect(changeEmits).toHaveLength(2)
			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "key1", value: "val1" }])
			expect(changeEmits).toContainEqual(["secureStoreChange", { key: "key2", value: "val2" }])
		})
	})

	describe("getEncryptionKey", () => {
		it("generates a key if none exists in ExpoSecureStore", async () => {
			mockExpoSecureStore.getItemAsync.mockResolvedValue(null)

			const store = createSecureStore()

			await store.init()

			expect(mockExpoSecureStore.setItemAsync).toHaveBeenCalledWith("encryptionKey.v1", expect.stringMatching(/^[0-9a-f]{64}$/))
		})

		it("reuses cached key on subsequent calls", async () => {
			const store = createSecureStore()

			await store.init()

			const firstCallCount = mockExpoSecureStore.getItemAsync.mock.calls.length

			// set triggers another getEncryptionKey internally
			await store.set("test", "value")

			// getItemAsync should not be called again — key is cached
			expect(mockExpoSecureStore.getItemAsync.mock.calls.length).toBe(firstCallCount)
		})

		it("falls back to MMKV when ExpoSecureStore is not available", async () => {
			mockExpoSecureStore.isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue(undefined)

			const store = createSecureStore()

			await store.init()

			expect(mockMmkv.set).toHaveBeenCalledWith("encryptionKey.v1", expect.stringMatching(/^[0-9a-f]{64}$/))
		})

		it("retrieves existing key from MMKV when available", async () => {
			mockExpoSecureStore.isAvailableAsync.mockResolvedValue(false)
			mockMmkv.getString.mockReturnValue("a".repeat(64))

			const store = createSecureStore()

			await store.init()

			// Should not generate a new key
			expect(mockMmkv.set).not.toHaveBeenCalled()
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

		it("does not return null for falsy value 0", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("zero", 0)

			const result = await store.get("zero")

			expect(result).not.toBeNull()
			expect(result).toBe(0)
		})

		it("does not return null for falsy value false", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("flag", false)

			const result = await store.get("flag")

			expect(result).not.toBeNull()
			expect(result).toBe(false)
		})

		it("does not return null for empty string", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("empty", "")

			const result = await store.get("empty")

			expect(result).not.toBeNull()
			expect(result).toBe("")
		})
	})

	describe("set then get roundtrip", () => {
		it("roundtrips a string value", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("greeting", "hello world")

			const result = await store.get("greeting")

			expect(result).toBe("hello world")
		})

		it("roundtrips a complex object", async () => {
			const store = createSecureStore()

			await store.init()

			const data = {
				name: "Alice",
				age: 30,
				tags: ["admin", "user"],
				nested: { foo: "bar" }
			}

			await store.set("profile", data)

			const result = await store.get("profile")

			expect(result).toEqual(data)
		})

		it("roundtrips a number", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("count", 42)

			const result = await store.get("count")

			expect(result).toBe(42)
		})

		it("roundtrips a boolean", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("active", true)

			const result = await store.get("active")

			expect(result).toBe(true)
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

			await store1.init()

			await store1.set("secret", "encrypted-data")

			// Get the encryption key that was generated
			const setCall = mockExpoSecureStore.setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			// Create a new instance that retrieves the same key
			mockExpoSecureStore.getItemAsync.mockResolvedValue(encryptionKey)

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
			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"
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

			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"
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

			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"

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
	})

	describe("corrupted file handling", () => {
		it("handles corrupted file gracefully on init", async () => {
			const store1 = createSecureStore()

			await store1.init()
			await store1.set("key", "value")

			const setCall = mockExpoSecureStore.setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			// Corrupt the file
			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"

			fs.set(fileUri, new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]))

			// Second store should handle corrupted file gracefully
			mockExpoSecureStore.getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await expect(store2.init()).resolves.not.toThrow()

			const result = await store2.get("key")

			expect(result).toBeNull()
		})

		it("can write new data after encountering corrupted file", async () => {
			const store1 = createSecureStore()

			await store1.init()
			await store1.set("old", "data")

			const setCall = mockExpoSecureStore.setItemAsync.mock.calls[0] as [string, string]
			const encryptionKey = setCall[1]

			// Corrupt the file
			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"

			fs.set(fileUri, new Uint8Array([0x00, 0x01, 0x02]))

			mockExpoSecureStore.getItemAsync.mockResolvedValue(encryptionKey)

			const store2 = createSecureStore()

			await store2.init()

			await store2.set("new", "value")

			const result = await store2.get("new")

			expect(result).toBe("value")
		})

		it("handles zero-length file as empty store", async () => {
			const store1 = createSecureStore()

			await store1.init()

			// Overwrite with empty file
			const fileUri = "file:///shared/group.io.filen.app/securestore.v1.bin"

			fs.set(fileUri, new Uint8Array(0))

			mockExpoSecureStore.getItemAsync.mockResolvedValue(null)

			const store2 = createSecureStore()

			await store2.init()

			const result = await store2.get("key")

			expect(result).toBeNull()
		})
	})

	describe("clear followed by concurrent set", () => {
		it("set after clear persists new value", async () => {
			const store = createSecureStore()

			await store.init()

			await store.set("existing", "value")

			// clear is serialized before set via modMutex
			await Promise.all([store.clear(), store.set("new", "data")])

			const newVal = await store.get("new")

			expect(newVal).toBe("data")

			const oldVal = await store.get("existing")

			expect(oldVal).toBeNull()
		})
	})
})
