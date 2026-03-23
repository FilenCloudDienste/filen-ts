// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreMap, mockEventEmitter } = vi.hoisted(() => {
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

		clear() {
			this.listeners.clear()
		}
	}

	return {
		mockSecureStoreMap: new Map<string, unknown>(),
		mockEventEmitter: new MockEventEmitter()
	}
})

vi.mock("uniffi-bindgen-react-native", () => ({
	NativeEventEmitter: vi.fn(),
	UniffiEnum: class {
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-secure-store", () => ({
	isAvailableAsync: vi.fn().mockResolvedValue(true),
	getItemAsync: vi.fn().mockResolvedValue(null),
	setItemAsync: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("react-native-mmkv", () => ({
	createMMKV: () => ({
		getString: vi.fn().mockReturnValue(undefined),
		set: vi.fn()
	})
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
	default: mockEventEmitter
}))

vi.mock("@/constants", () => ({
	IOS_APP_GROUP_IDENTIFIER: "group.io.filen.app"
}))

vi.mock("@/lib/memo", () => ({
	useCallback: (fn: unknown) => fn,
	useMemo: (fn: () => unknown) => fn(),
	memo: (component: unknown) => component
}))

vi.mock("@/lib/utils", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

import { renderHook, act, waitFor } from "@testing-library/react"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { fs } from "@/tests/mocks/expoFileSystem"

beforeEach(async () => {
	fs.clear()
	mockSecureStoreMap.clear()
	mockEventEmitter.clear()

	// Reset singleton internal state for test isolation
	const s = secureStore as any

	s.readCache = null
	s.initDone = false
	s.encryptionKey = null
	s.available = null

	await secureStore.init()
})

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
		it("unsubscribes from events on unmount", () => {
			const { result, unmount } = renderHook(() => useSecureStore("testKey", "initial"))

			// Verify events work before unmount
			act(() => {
				mockEventEmitter.emit("secureStoreChange", { key: "testKey", value: "changed" })
			})

			expect(result.current[0]).toBe("changed")

			unmount()

			// After unmount, the listener should be removed.
			// We can't check state after unmount, but we verify no errors are thrown.
			mockEventEmitter.emit("secureStoreChange", { key: "testKey", value: "afterUnmount" })
		})
	})
})
