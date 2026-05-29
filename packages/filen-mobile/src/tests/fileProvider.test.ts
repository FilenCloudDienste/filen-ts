import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreData } = vi.hoisted(() => {
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "test-fallback-key-1234567890abcdef"

	return {
		mockSecureStoreData: new Map<string, unknown>()
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

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

		it("returns true after enable()", async () => {
			await fileProvider.enable()

			const result = await fileProvider.enabled()

			expect(result).toBe(true)
		})

		it("returns false after disable()", async () => {
			await fileProvider.enable()
			await fileProvider.disable()

			const result = await fileProvider.enabled()

			expect(result).toBe(false)
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
			const thumbnailBudget = Math.floor((256 * 1024 * 1024) / 4)
			const cacheBudget = 256 * 1024 * 1024 - thumbnailBudget

			expect(data.maxThumbnailFilesBudget).toBe(thumbnailBudget)
			expect(data.maxCacheFilesBudget).toBe(cacheBudget)
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
	})
})
