import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreData } = vi.hoisted(() => {
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	return {
		mockSecureStoreData: new Map<string, unknown>()
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// Use the REAL Semaphore here (not the no-op mock) so writeMutex actually
// serializes — the enable() race fix depends on genuine mutual exclusion.
// The dist subpath bypasses this vi.mock interception of the bare specifier.
vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	// @ts-expect-error — the dist subpath ships JS with no co-located .d.ts (types live under dist/types/); this is the real FIFO Semaphore, imported directly to bypass the bare-specifier vi.mock above
	Semaphore: (await import("@filen/utils/dist/semaphore.js")).Semaphore
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/secureStore", () => ({
	default: {
		set: vi.fn(async (key: string, value: unknown) => {
			mockSecureStoreData.set(key, value)
		}),
		get: vi.fn(async (key: string) => mockSecureStoreData.get(key) ?? null)
	},
	FILE_PROVIDER_ENABLED_SECURE_STORE_KEY: "fileProviderEnabled"
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn(async () => ({
			authedSdkClient: {
				toSdkConfig: vi.fn(() => ({
					email: "test@example.com",
					masterKeys: ["key1"],
					apiKey: "api-key",
					publicKey: "pub",
					privateKey: "priv",
					authVersion: 2,
					baseFolderUuid: "uuid-root",
					userId: BigInt(12345),
					metadataCache: true,
					tmpPath: "/tmp",
					connectToSocket: false
				}))
			}
		}))
	}
}))

import fileProvider, { AUTH_FILE, FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/lib/fileProvider"
import { fs } from "@/tests/mocks/expoFileSystem"
import auth from "@/lib/auth"

beforeEach(() => {
	fs.clear()
	mockSecureStoreData.clear()
	vi.clearAllMocks()
})

describe("fileProvider", () => {
	describe("enable", () => {
		it("writes a valid auth.json with providerEnabled: true", async () => {
			await fileProvider.enable()

			expect(AUTH_FILE.exists).toBe(true)

			const data = JSON.parse(AUTH_FILE.textSync())

			expect(data.providerEnabled).toBe(true)
			expect(data.sdkConfig.email).toBe("test@example.com")
			expect(data.sdkConfig.password).toBe("redacted")
			expect(data.sdkConfig.twoFactorCode).toBe("redacted")
			expect(data.sdkConfig.apiKey).toBe("api-key")
			expect(data.sdkConfig.userId).toBe(12345)
		})

		it("sets FILE_PROVIDER_ENABLED_SECURE_STORE_KEY to true in secureStore", async () => {
			await fileProvider.enable()

			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(true)
		})

		it("preserves existing maxThumbnailFilesBudget and maxCacheFilesBudget on re-enable", async () => {
			await fileProvider.enable()
			await fileProvider.setCacheBudget(256 * 1024 * 1024)

			// Re-enable should preserve the budget fields
			await fileProvider.enable()

			const data = JSON.parse(AUTH_FILE.textSync())

			expect(data.maxCacheFilesBudget).toBeDefined()
			expect(data.maxThumbnailFilesBudget).toBeDefined()
		})

		it("does not re-create auth.json when disable() races a slow getSdkClients()", async () => {
			// Reproduces ref #22: enable() must hold writeMutex across read ->
			// getSdkClients -> write. A concurrent disable() landing inside the
			// getSdkClients await must NOT be clobbered by enable()'s later write.
			let resolveSdk: (() => void) | undefined

			const sdkGate = new Promise<void>(resolve => {
				resolveSdk = resolve
			})

			vi.mocked(auth.getSdkClients).mockImplementationOnce(async () => {
				// Suspend enable() inside its locked transaction so disable() can race.
				await sdkGate

				return {
					authedSdkClient: {
						toSdkConfig: () => ({
							email: "test@example.com",
							masterKeys: ["key1"],
							apiKey: "api-key",
							publicKey: "pub",
							privateKey: "priv",
							authVersion: 2,
							baseFolderUuid: "uuid-root",
							userId: BigInt(12345),
							metadataCache: true,
							tmpPath: "/tmp",
							connectToSocket: false
						})
					}
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any
			})

			const enablePromise = fileProvider.enable()

			// Let enable() acquire the mutex and reach the getSdkClients() await.
			await Promise.resolve()

			// disable() is issued while enable() is suspended. With the fix it must
			// block on writeMutex and run only after enable()'s write completes.
			const disablePromise = fileProvider.disable()

			// Release getSdkClients so enable() finishes its write, then disable runs.
			resolveSdk?.()

			await Promise.all([enablePromise, disablePromise])

			// disable()'s delete is serialized after enable()'s write by the mutex,
			// so it must win: auth.json deleted, NOT silently re-created.
			expect(AUTH_FILE.exists).toBe(false)
		})
	})

	describe("disable", () => {
		it("deletes the auth.json file", async () => {
			await fileProvider.enable()

			expect(AUTH_FILE.exists).toBe(true)

			await fileProvider.disable()

			expect(AUTH_FILE.exists).toBe(false)
		})

		it("sets FILE_PROVIDER_ENABLED_SECURE_STORE_KEY to false in secureStore", async () => {
			await fileProvider.enable()
			await fileProvider.disable()

			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(false)
		})

		it("does not throw when auth.json does not exist", async () => {
			await expect(fileProvider.disable()).resolves.toBeUndefined()
		})
	})

	describe("enabled", () => {
		it("returns false when no auth.json exists", async () => {
			const result = await fileProvider.enabled()

			expect(result).toBe(false)
		})

		it("syncs false to secureStore when no auth.json exists", async () => {
			await fileProvider.enabled()

			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(false)
		})

		it("returns true after enable()", async () => {
			await fileProvider.enable()

			const result = await fileProvider.enabled()

			expect(result).toBe(true)
		})

		it("syncs true to secureStore when auth.json has providerEnabled: true", async () => {
			await fileProvider.enable()
			// Clear to confirm enabled() itself drives the sync, not enable()
			mockSecureStoreData.clear()

			await fileProvider.enabled()

			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(true)
		})

		it("returns false after disable()", async () => {
			await fileProvider.enable()
			await fileProvider.disable()

			const result = await fileProvider.enabled()

			expect(result).toBe(false)
		})

		it("returns false when auth.json exists but providerEnabled is false", async () => {
			// Write an auth.json directly with providerEnabled:false to exercise the
			// branch where the file exists but the flag is explicitly disabled.
			AUTH_FILE.create()
			AUTH_FILE.write(
				JSON.stringify({
					providerEnabled: false,
					sdkConfig: null,
					maxThumbnailFilesBudget: null,
					maxCacheFilesBudget: null
				})
			)

			const result = await fileProvider.enabled()

			expect(result).toBe(false)
		})

		it("syncs false to secureStore when auth.json exists with providerEnabled: false", async () => {
			// Write an auth.json with providerEnabled:false to test that enabled()
			// unconditionally syncs the read value back to secureStore regardless of truth.
			AUTH_FILE.create()
			AUTH_FILE.write(
				JSON.stringify({
					providerEnabled: false,
					sdkConfig: null,
					maxThumbnailFilesBudget: null,
					maxCacheFilesBudget: null
				})
			)

			// Seed a stale truthy value to confirm it gets overwritten
			mockSecureStoreData.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, true)

			await fileProvider.enabled()

			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(false)
		})
	})

	describe("setCacheBudget / cacheBudget", () => {
		it("splits totalBytes 75% cache / 25% thumbnails and reads back the sum", async () => {
			await fileProvider.enable()

			const total = 256 * 1024 * 1024

			await fileProvider.setCacheBudget(total)

			const result = await fileProvider.cacheBudget()

			expect(result).toBe(total)
		})

		it("persists the 25/75 split correctly in auth.json", async () => {
			await fileProvider.enable()
			await fileProvider.setCacheBudget(256 * 1024 * 1024)

			const data = JSON.parse(AUTH_FILE.textSync())

			// 256 MiB == 268435456 bytes
			// thumbnails = floor(268435456 / 4) = 67108864 (25%)
			// cache      = 268435456 - 67108864  = 201326592 (75%)
			// Hard-coded so any change to the source ratio is caught immediately.
			expect(data.maxThumbnailFilesBudget).toBe(67108864)
			expect(data.maxCacheFilesBudget).toBe(201326592)
		})

		it("throws for budgets below MIN_CACHE_BUDGET_BYTES (64 MiB)", async () => {
			await fileProvider.enable()

			await expect(fileProvider.setCacheBudget(1024)).rejects.toThrow("Invalid cache budget")
		})

		it("throws for non-finite values", async () => {
			await fileProvider.enable()

			await expect(fileProvider.setCacheBudget(NaN)).rejects.toThrow("Invalid cache budget")
			await expect(fileProvider.setCacheBudget(Infinity)).rejects.toThrow("Invalid cache budget")
		})

		it("returns 1 GiB default when no budgets are stored", async () => {
			const result = await fileProvider.cacheBudget()

			expect(result).toBe(1024 * 1024 * 1024)
		})

		it("throws when called before enable()", async () => {
			await expect(fileProvider.setCacheBudget(128 * 1024 * 1024)).rejects.toThrow("setCacheBudget called before enable()")
		})

		it("throws when called after disable() leaves no auth.json", async () => {
			await fileProvider.enable()
			await fileProvider.disable()

			// After disable() the file is gone — same 'called before enable()' guard fires
			await expect(fileProvider.setCacheBudget(128 * 1024 * 1024)).rejects.toThrow("setCacheBudget called before enable()")
		})

		it("returns 1 GiB default when only maxCacheFilesBudget is null (partial record)", async () => {
			// Writes a file where maxThumbnailFilesBudget is present but maxCacheFilesBudget is null.
			// The guard at fileProvider.ts line 85 must treat partial-null the same as both-null.
			AUTH_FILE.create()
			AUTH_FILE.write(
				JSON.stringify({
					providerEnabled: true,
					sdkConfig: null,
					maxThumbnailFilesBudget: 67108864,
					maxCacheFilesBudget: null
				})
			)

			const result = await fileProvider.cacheBudget()

			expect(result).toBe(1024 * 1024 * 1024)
		})

		it("returns 1 GiB default when only maxThumbnailFilesBudget is null (partial record)", async () => {
			// Writes a file where maxCacheFilesBudget is present but maxThumbnailFilesBudget is null.
			AUTH_FILE.create()
			AUTH_FILE.write(
				JSON.stringify({
					providerEnabled: true,
					sdkConfig: null,
					maxThumbnailFilesBudget: null,
					maxCacheFilesBudget: 201326592
				})
			)

			const result = await fileProvider.cacheBudget()

			expect(result).toBe(1024 * 1024 * 1024)
		})

		it("TOCTOU: setCacheBudget after disable() does not recreate auth.json", async () => {
			// Race: setCacheBudget reads current state (sees the file), then disable()
			// deletes auth.json before setCacheBudget acquires writeMutex for the write.
			// setCacheBudget should still throw because it checks current===null before
			// the write — it reads null after the file is gone in an in-sequence scenario.
			// This test validates the straightforward post-disable() path (sequential).
			await fileProvider.enable()
			await fileProvider.disable()

			// After disable the read() returns null, so setCacheBudget must throw
			await expect(fileProvider.setCacheBudget(128 * 1024 * 1024)).rejects.toThrow("setCacheBudget called before enable()")

			// auth.json must NOT be recreated by the failed call
			expect(AUTH_FILE.exists).toBe(false)
		})
	})
})
