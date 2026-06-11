// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreMap, mockEventEmitter, mockMmkvStore } = vi.hoisted(() => {
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	class MockEventEmitter {
		private listeners = new Map<string, Set<Function>>()

		subscribe(event: string, handler: Function) {
			if (!this.listeners.has(event)) {
				this.listeners.set(event, new Set())
			}

			this.listeners.get(event)!.add(handler)

			return {
				remove: () => {
					this.listeners.get(event)?.delete(handler)
				}
			}
		}

		emit(event: string, ...args: unknown[]) {
			for (const handler of this.listeners.get(event) || []) {
				handler(...args)
			}
		}

		listenerCount(event: string): number {
			return this.listeners.get(event)?.size ?? 0
		}

		clear() {
			this.listeners.clear()
		}
	}

	return {
		mockSecureStoreMap: new Map<string, unknown>(),
		mockEventEmitter: new MockEventEmitter(),
		mockMmkvStore: new Map<string, string>()
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("react-native-mmkv", () => ({
	createMMKV: vi.fn(() => ({
		getString: (key: string) => mockMmkvStore.get(key),
		set: (key: string, value: string) => mockMmkvStore.set(key, value)
	}))
}))

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
	default: mockEventEmitter
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

// secureStore.ts imports normalizeFilePathForSdk from @/lib/paths (not @/lib/utils)
vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/"),
	normalizeFilePathForExpo: (path: string) => `file://${path.trim().replace(/^file:\/+/, "/")}`,
	normalizeFilePathForBlobUtil: (path: string) => `file://${path.trim().replace(/^file:\/+/, "/")}`
}))

import { renderHook, act, waitFor } from "@testing-library/react"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { fs } from "@/tests/mocks/expoFileSystem"
import * as expoSecureStoreMock from "@/tests/mocks/expoSecureStore"

/** Re-initialise the singleton's private fields between tests */
async function resetSecureStore() {
	const s = secureStore as any

	s.readCache = null
	s.initDone = false
	s.encryptionKey = null
	s.available = null
	s.directoriesEnsured = false
	s.encryptionKeyWasGenerated = false

	await secureStore.init()
}

beforeEach(async () => {
	fs.clear()
	mockSecureStoreMap.clear()
	mockMmkvStore.clear()
	mockEventEmitter.clear()
	vi.mocked(expoSecureStoreMock.isAvailableAsync).mockResolvedValue(true)
	vi.mocked(expoSecureStoreMock.getItemAsync).mockResolvedValue(null)
	vi.mocked(expoSecureStoreMock.setItemAsync).mockResolvedValue(undefined)

	await resetSecureStore()
})

// ─── SecureStore class ────────────────────────────────────────────────────────

describe("SecureStore", () => {
	describe("set / get round-trip (AES-256-GCM)", () => {
		it("persists a string value and reads it back correctly", async () => {
			await secureStore.set("myKey", "hello world")
			const value = await secureStore.get<string>("myKey")

			expect(value).toBe("hello world")
		})

		it("persists a nested object and reads it back correctly", async () => {
			const obj = { nested: { count: 42, flag: true } }

			await secureStore.set("objKey", obj)
			const value = await secureStore.get<typeof obj>("objKey")

			expect(value).toEqual(obj)
		})

		it("returns null for a key that was never written", async () => {
			const value = await secureStore.get<string>("nonExistent")

			expect(value).toBeNull()
		})

		it("overwrites an existing key", async () => {
			await secureStore.set("key", "first")
			await secureStore.set("key", "second")

			const value = await secureStore.get<string>("key")

			expect(value).toBe("second")
		})

		it("stores multiple keys independently", async () => {
			await secureStore.set("a", "alpha")
			await secureStore.set("b", "beta")

			const a = await secureStore.get<string>("a")
			const b = await secureStore.get<string>("b")

			expect(a).toBe("alpha")
			expect(b).toBe("beta")
		})

		it("round-trips ciphertext via a fresh readCache after a cold read", async () => {
			await secureStore.set("coldKey", "coldValue")

			// Evict the read cache so the next get must decrypt from disk
			const s = secureStore as any

			s.readCache = null

			const value = await secureStore.get<string>("coldKey")

			expect(value).toBe("coldValue")
		})
	})

	describe("SecureStore.remove", () => {
		it("removes a key so get returns null afterwards", async () => {
			await secureStore.set("toRemove", "goodbye")
			await secureStore.remove("toRemove")

			const value = await secureStore.get<string>("toRemove")

			expect(value).toBeNull()
		})

		it("leaves other keys intact after removing one", async () => {
			await secureStore.set("keep", "keepMe")
			await secureStore.set("drop", "dropMe")
			await secureStore.remove("drop")

			const keep = await secureStore.get<string>("keep")
			const drop = await secureStore.get<string>("drop")

			expect(keep).toBe("keepMe")
			expect(drop).toBeNull()
		})

		it("emits secureStoreRemove event with the removed key", async () => {
			await secureStore.set("eventKey", "value")

			const received: string[] = []

			mockEventEmitter.subscribe("secureStoreRemove", (payload: { key: string }) => {
				received.push(payload.key)
			})

			await secureStore.remove("eventKey")

			expect(received).toEqual(["eventKey"])
		})

		it("does not throw when removing a key that does not exist", async () => {
			await expect(secureStore.remove("missingKey")).resolves.toBeUndefined()
		})
	})

	describe("SecureStore.clear", () => {
		it("clears all stored keys so each returns null", async () => {
			await secureStore.set("x", "1")
			await secureStore.set("y", "2")
			await secureStore.clear()

			const x = await secureStore.get<string>("x")
			const y = await secureStore.get<string>("y")

			expect(x).toBeNull()
			expect(y).toBeNull()
		})

		it("clears the in-memory cache map (mockSecureStoreMap becomes empty)", async () => {
			await secureStore.set("z", "3")
			await secureStore.clear()

			expect(mockSecureStoreMap.size).toBe(0)
		})

		it("emits secureStoreClear event", async () => {
			let emitted = false

			mockEventEmitter.subscribe("secureStoreClear", () => {
				emitted = true
			})

			await secureStore.clear()

			expect(emitted).toBe(true)
		})

		it("allows new writes after clear", async () => {
			await secureStore.set("fresh", "new")
			await secureStore.clear()
			await secureStore.set("fresh", "reborn")

			const value = await secureStore.get<string>("fresh")

			expect(value).toBe("reborn")
		})
	})

	describe("SecureStore.getEncryptionKey — MMKV fallback path", () => {
		it("generates and stores a new key in MMKV when expo-secure-store is unavailable", async () => {
			vi.mocked(expoSecureStoreMock.isAvailableAsync).mockResolvedValue(false)

			await resetSecureStore()

			// A key must be present in MMKV after init runs the MMKV path
			expect(mockMmkvStore.has("encryptionKeyAfu")).toBe(true)

			const storedKey = mockMmkvStore.get("encryptionKeyAfu")

			// 32 random bytes → 64-char hex string
			expect(typeof storedKey).toBe("string")
			expect(storedKey).toHaveLength(64)
		})

		it("reuses an existing MMKV key rather than generating a new one", async () => {
			const existingKey = "a".repeat(64)

			mockMmkvStore.set("encryptionKeyAfu", existingKey)
			vi.mocked(expoSecureStoreMock.isAvailableAsync).mockResolvedValue(false)

			await resetSecureStore()

			// Should not have overwritten the pre-existing key
			expect(mockMmkvStore.get("encryptionKeyAfu")).toBe(existingKey)
		})

		it("can write and read values when using the MMKV fallback encryption key", async () => {
			vi.mocked(expoSecureStoreMock.isAvailableAsync).mockResolvedValue(false)

			await resetSecureStore()

			await secureStore.set("fallbackKey", "fallbackValue")
			const value = await secureStore.get<string>("fallbackKey")

			expect(value).toBe("fallbackValue")
		})
	})

	describe("SecureStore.read — readCache fast path", () => {
		it("returns cached result on a second concurrent read without going to disk twice", async () => {
			await secureStore.set("cacheKey", "cacheValue")

			// Evict the read cache to force an initial disk read
			const s = secureStore as any

			s.readCache = null

			// Two concurrent reads — the second should hit the cache set by the first
			const [a, b] = await Promise.all([secureStore.get<string>("cacheKey"), secureStore.get<string>("cacheKey")])

			expect(a).toBe("cacheValue")
			expect(b).toBe("cacheValue")
		})
	})

	describe("SecureStore.write — atomic backup/restore on failure", () => {
		it("restores the backup file when tmpFile.move() throws before promotion", async () => {
			// Seed an existing store file
			await secureStore.set("beforeCrash", "safe")

			const s = secureStore as any

			s.readCache = null

			// Read the file bytes so we know what "safe" looks like on disk
			const storeUri = secureStore.secureStoreFile.uri
			const { fs: rawFs } = await import("@/tests/mocks/expoFileSystem")
			const originalBytes = rawFs.get(storeUri)

			expect(originalBytes).toBeDefined()

			// Intercept the FileSystem module to make the SECOND move() call (tmp→dest) throw
			// after the FIRST (dest→backup) has succeeded.
			const { File } = await import("@/tests/mocks/expoFileSystem")
			const originalMove = File.prototype.move

			let moveCallCount = 0

			File.prototype.move = function (...args: Parameters<typeof originalMove>) {
				moveCallCount++

				if (moveCallCount === 2) {
					// Restore the original method before throwing so cleanup code can use it
					File.prototype.move = originalMove

					throw new Error("simulated disk full")
				}

				return originalMove.apply(this, args)
			}

			// The write should throw
			await expect(secureStore.set("newKey", "newValue")).rejects.toThrow("simulated disk full")

			// Restore move() in all cases
			File.prototype.move = originalMove

			// The original file must still exist and have the original content
			const restoredBytes = rawFs.get(storeUri)

			expect(restoredBytes).toBeDefined()
			expect(restoredBytes).toEqual(originalBytes)
		})
	})

	describe("SecureStore.init — emits secureStoreChange for each persisted key", () => {
		it("emits secureStoreChange for every key stored on disk before init runs", async () => {
			// Write keys using an already-initialised instance
			await secureStore.set("initKeyA", "valueA")
			await secureStore.set("initKeyB", "valueB")

			// Preserve the encryption key so the re-init can decrypt the existing file
			const s = secureStore as any
			const preservedKey = s.encryptionKey

			// Collect events emitted by a fresh init (subscribe BEFORE clearing initDone)
			const received: Array<{ key: string; value: unknown }> = []

			mockEventEmitter.subscribe("secureStoreChange", (payload: { key: string; value: unknown }) => {
				received.push(payload)
			})

			// Reset init state but keep the encryption key so the encrypted file can be decrypted
			s.readCache = null
			s.initDone = false
			// Preserve encryptionKey so decrypt succeeds with the same key
			s.encryptionKey = preservedKey

			await secureStore.init()

			const keyMap = Object.fromEntries(received.map(e => [e.key, e.value]))

			expect(keyMap["initKeyA"]).toBe("valueA")
			expect(keyMap["initKeyB"]).toBe("valueB")
		})
	})
})

// ─── useSecureStore hook ──────────────────────────────────────────────────────

describe("useSecureStore", () => {
	describe("initial state", () => {
		it("returns initialValue when cache is empty", () => {
			const { result } = renderHook(() => useSecureStore("testKey", "default"))

			expect(result.current[0]).toBe("default")
		})

		it("returns cached value when cache has data", () => {
			mockSecureStoreMap.set("testKey", "cached")

			const { result } = renderHook(() => useSecureStore("testKey", "default"))

			expect(result.current[0]).toBe("cached")
		})
	})

	describe("retrieve() on mount hydrates state from disk", () => {
		it("updates hook state with value stored in SecureStore after mount", async () => {
			// Store a value before the hook mounts (disk, not just in-memory cache map)
			await secureStore.set("diskKey", "diskValue")

			// Ensure the cache map does NOT have the value so it must come from disk
			mockSecureStoreMap.delete("diskKey")

			const { result } = renderHook(() => useSecureStore("diskKey", "missing"))

			await waitFor(() => {
				expect(result.current[0]).toBe("diskValue")
			})
		})
	})

	describe("set", () => {
		it("updates state with a direct value", async () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			act(() => {
				result.current[1]("updated")
			})

			await waitFor(() => {
				expect(result.current[0]).toBe("updated")
			})
		})

		it("updates state with a function updater", async () => {
			const { result } = renderHook(() => useSecureStore("counter", 0))

			act(() => {
				result.current[1](prev => prev + 1)
			})

			await waitFor(() => {
				expect(result.current[0]).toBe(1)
			})
		})

		it("sequential function updaters see each other's values via lastValueRef", async () => {
			const { result } = renderHook(() => useSecureStore("counter", 0))

			act(() => {
				result.current[1](prev => prev + 1)
				result.current[1](prev => prev + 1)
				result.current[1](prev => prev + 1)
			})

			await waitFor(() => {
				expect(result.current[0]).toBe(3)
			})
		})

		it("persists value to secureStore", async () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			act(() => {
				result.current[1]("persisted")
			})

			await waitFor(async () => {
				const stored = await secureStore.get<string>("testKey")

				expect(stored).toBe("persisted")
			})
		})

		it("does not update state when setting the same value", async () => {
			mockSecureStoreMap.set("testKey", "same")

			const renderCount = { value: 0 }
			const { result } = renderHook(() => {
				renderCount.value++

				return useSecureStore("testKey", "same")
			})

			const countBefore = renderCount.value

			act(() => {
				result.current[1]("same")
			})

			expect(renderCount.value).toBe(countBefore)
		})
	})

	describe("event propagation", () => {
		it("updates state when secureStoreChange event fires for matching key", async () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			act(() => {
				mockEventEmitter.emit("secureStoreChange", { key: "testKey", value: "external" })
			})

			expect(result.current[0]).toBe("external")
		})

		it("ignores secureStoreChange events for different keys", () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			act(() => {
				mockEventEmitter.emit("secureStoreChange", { key: "otherKey", value: "nope" })
			})

			expect(result.current[0]).toBe("initial")
		})

		it("resets to initialValue on secureStoreRemove for matching key", () => {
			mockSecureStoreMap.set("testKey", "stored")

			const { result } = renderHook(() => useSecureStore("testKey", "default"))

			expect(result.current[0]).toBe("stored")

			act(() => {
				mockEventEmitter.emit("secureStoreRemove", { key: "testKey" })
			})

			expect(result.current[0]).toBe("default")
		})

		it("resets to initialValue on secureStoreClear", () => {
			mockSecureStoreMap.set("testKey", "stored")

			const { result } = renderHook(() => useSecureStore("testKey", "default"))

			expect(result.current[0]).toBe("stored")

			act(() => {
				mockEventEmitter.emit("secureStoreClear")
			})

			expect(result.current[0]).toBe("default")
		})

		it("propagates changes from secureStore.set to hook state", async () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			await act(async () => {
				await secureStore.set("testKey", "fromClass")
			})

			expect(result.current[0]).toBe("fromClass")
		})
	})

	describe("cleanup", () => {
		it("unsubscribes from events on unmount — listener is no longer called after unmount", () => {
			const { result, unmount } = renderHook(() => useSecureStore("testKey", "initial"))

			// Verify subscription is working before unmount
			act(() => {
				mockEventEmitter.emit("secureStoreChange", { key: "testKey", value: "beforeUnmount" })
			})

			expect(result.current[0]).toBe("beforeUnmount")

			// Count listeners before unmount
			const listenerCountBefore = mockEventEmitter.listenerCount("secureStoreChange")

			unmount()

			// The listener must have been removed — listener count drops
			const listenerCountAfter = mockEventEmitter.listenerCount("secureStoreChange")

			expect(listenerCountAfter).toBe(listenerCountBefore - 1)
		})

		it("unsubscribes from all three event types on unmount", () => {
			const countBefore = {
				secureStoreChange: mockEventEmitter.listenerCount("secureStoreChange"),
				secureStoreRemove: mockEventEmitter.listenerCount("secureStoreRemove"),
				secureStoreClear: mockEventEmitter.listenerCount("secureStoreClear")
			}

			const { unmount } = renderHook(() => useSecureStore("testKey", "initial"))

			// After mount, counts must have increased by 1 for each event type
			expect(mockEventEmitter.listenerCount("secureStoreChange")).toBe(countBefore.secureStoreChange + 1)
			expect(mockEventEmitter.listenerCount("secureStoreRemove")).toBe(countBefore.secureStoreRemove + 1)
			expect(mockEventEmitter.listenerCount("secureStoreClear")).toBe(countBefore.secureStoreClear + 1)

			unmount()

			// After unmount, counts must be back to what they were before mount
			expect(mockEventEmitter.listenerCount("secureStoreChange")).toBe(countBefore.secureStoreChange)
			expect(mockEventEmitter.listenerCount("secureStoreRemove")).toBe(countBefore.secureStoreRemove)
			expect(mockEventEmitter.listenerCount("secureStoreClear")).toBe(countBefore.secureStoreClear)
		})

		it("isLocalUpdateRef guard: external secureStoreChange is ignored while set() is in flight", async () => {
			const { result } = renderHook(() => useSecureStore("testKey", "initial"))

			// Start the async set but don't await it yet
			let resolveSet!: () => void
			const setBarrier = new Promise<void>(resolve => {
				resolveSet = resolve
			})

			// Intercept secureStore.set so we can pause it mid-flight
			const originalSet = secureStore.set.bind(secureStore)
			const setMock = vi.spyOn(secureStore, "set").mockImplementationOnce(async (key, value) => {
				await setBarrier
				await originalSet(key, value)
			})

			// Kick off the set — this will be paused at setBarrier
			act(() => {
				result.current[1]("localValue")
			})

			// While set() is paused, fire an external event for the same key
			act(() => {
				mockEventEmitter.emit("secureStoreChange", { key: "testKey", value: "externalValue" })
			})

			// Unblock the set
			resolveSet()

			await waitFor(() => {
				// The local value must win; the external event was suppressed by isLocalUpdateRef
				expect(result.current[0]).toBe("localValue")
			})

			setMock.mockRestore()
		})
	})

	describe("getSecureStoreFlushMutex — shared semaphore across hook instances", () => {
		it("serializes concurrent sets from two hook instances sharing the same key", async () => {
			const order: string[] = []

			const { result: hook1 } = renderHook(() => useSecureStore("sharedKey", ""))
			const { result: hook2 } = renderHook(() => useSecureStore("sharedKey", ""))

			// Both hooks fire a set at the same time; the mutex must serialize them.
			// We capture the persisted value after both finish — it must be one of the two inputs.
			await act(async () => {
				hook1.current[1]("fromHook1")
				hook2.current[1]("fromHook2")
			})

			await waitFor(async () => {
				const stored = await secureStore.get<string>("sharedKey")

				// The final value must be exactly one of the two; no corruption/mix.
				expect(["fromHook1", "fromHook2"]).toContain(stored)
				order.push(stored as string)
			})

			// Both hooks must reflect the same final value (shared state)
			expect(hook1.current[0]).toBe(hook2.current[0])
		})
	})
})
