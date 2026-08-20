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

// authFileKey pulls in native modules (expo-secure-store, the Android Keystore module) + quick-crypto.
// Passthrough seal/open so the test file holds plaintext JSON and the content assertions still hold;
// the real AES-256-GCM round-trip is covered by authFileKey.test.ts + the Rust decrypt unit tests.
vi.mock("@/features/settings/authFileKey", () => ({
	getOrCreateAuthDek: vi.fn(async () => new Uint8Array(32)),
	purgeAuthDek: vi.fn(async () => {}),
	sealAuthFile: (plaintext: string) => new TextEncoder().encode(plaintext),
	openAuthFile: (sealed: Uint8Array) => new TextDecoder().decode(sealed)
}))

// The domain module calls requireOptionalNativeModule() at import, which is unloadable in the node
// test env. Mocked per-file (the same way authFileKey.test.ts mocks @/modules/filen-auth-key) —
// fileProvider.test.ts is the only suite that loads the real fileProvider module.
vi.mock("@/modules/file-provider-domain", () => ({
	registerDomain: vi.fn(async () => {}),
	unregisterDomain: vi.fn(async () => {}),
	isDomainRegistered: vi.fn(async () => false)
}))

// fsAtomic pulls in expo-crypto (randomUUID) and the tmp helpers, which are unloadable in the node
// test env. The mock preserves the observable contract writeUnlocked relies on: the destination
// ends up holding exactly the sealed payload.
vi.mock("@/lib/fsAtomic", () => ({
	atomicWrite: (file: { exists: boolean; delete: () => void; create: () => void; write: (data: unknown) => void }, data: unknown) => {
		if (file.exists) {
			file.delete()
		}

		file.create()
		file.write(data)

		return file
	}
}))

import fileProvider, {
	AUTH_FILE,
	FILE_PROVIDER_ENABLED_SECURE_STORE_KEY,
	FILE_PROVIDER_DOMAIN_IDENTIFIER,
	FILE_PROVIDER_DOMAIN_DISPLAY_NAME
} from "@/features/settings/fileProvider"
import { fs } from "@/tests/mocks/expoFileSystem"
import auth from "@/lib/auth"
import { Platform } from "@/tests/mocks/reactNative"
import { registerDomain, unregisterDomain, isDomainRegistered } from "@/modules/file-provider-domain"

beforeEach(() => {
	fs.clear()
	mockSecureStoreData.clear()
	vi.clearAllMocks()

	Platform.OS = "ios"
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
			// 256 MiB → thumbnails = floor(268435456 / 4) = 67108864, cache = 201326592
			await fileProvider.setCacheBudget(256 * 1024 * 1024)

			// Re-enable should preserve the exact budget values — not zero or overwrite them
			await fileProvider.enable()

			const data = JSON.parse(AUTH_FILE.textSync())

			expect(data.maxThumbnailFilesBudget).toBe(67108864)
			expect(data.maxCacheFilesBudget).toBe(201326592)
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

	describe("domain registration", () => {
		it("enable() registers the domain, and only after auth.json exists", async () => {
			// Ordering matters: the extension is instantiated by the registration, so the credentials
			// must already be on disk when it comes up.
			let authFileExistedAtRegistration: boolean | undefined

			vi.mocked(registerDomain).mockImplementationOnce(async () => {
				authFileExistedAtRegistration = AUTH_FILE.exists
			})

			await fileProvider.enable()

			expect(registerDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER, FILE_PROVIDER_DOMAIN_DISPLAY_NAME)
			expect(authFileExistedAtRegistration).toBe(true)
		})

		it("disable() unregisters the domain, and before auth.json is deleted", async () => {
			await fileProvider.enable()

			let authFileExistedAtUnregistration: boolean | undefined

			vi.mocked(unregisterDomain).mockImplementationOnce(async () => {
				authFileExistedAtUnregistration = AUTH_FILE.exists
			})

			await fileProvider.disable()

			expect(unregisterDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER)
			expect(authFileExistedAtUnregistration).toBe(true)
			expect(AUTH_FILE.exists).toBe(false)
		})

		it("a failed registration fails enable(), leaving auth.json for the startup reconcile", async () => {
			vi.mocked(registerDomain).mockRejectedValueOnce(new Error("NSFileProviderErrorDomain -2011"))

			await expect(fileProvider.enable()).rejects.toThrow()

			// Swallowing the failure reported the provider as enabled while no domain existed and
			// nothing ever showed up in Files.app. auth.json deliberately stays enabled so
			// reconcileDomainRegistration() retries the registration on every authed launch — but
			// the caller must see the failure, and the UI flag must not flip on this call.
			expect(AUTH_FILE.exists).toBe(true)
			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBeUndefined()
		})

		it("reports freshlyRegistered exactly when the domain was not registered before", async () => {
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(false)

			await expect(fileProvider.enable()).resolves.toEqual({ freshlyRegistered: true })

			vi.mocked(isDomainRegistered).mockResolvedValueOnce(true)

			await expect(fileProvider.enable()).resolves.toEqual({ freshlyRegistered: false })
		})

		it("a failed unregistration still clears the credentials", async () => {
			await fileProvider.enable()

			vi.mocked(unregisterDomain).mockRejectedValueOnce(new Error("domain stuck"))

			await expect(fileProvider.disable()).resolves.toBeUndefined()

			expect(AUTH_FILE.exists).toBe(false)
			expect(mockSecureStoreData.get(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY)).toBe(false)
		})

		it("does not touch domains on Android", async () => {
			Platform.OS = "android"

			await fileProvider.enable()
			await fileProvider.disable()

			expect(registerDomain).not.toHaveBeenCalled()
			expect(unregisterDomain).not.toHaveBeenCalled()
		})
	})

	describe("reconcileDomainRegistration", () => {
		it("registers a missing domain while the provider is enabled", async () => {
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(false)

			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: true })

			expect(registerDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER, FILE_PROVIDER_DOMAIN_DISPLAY_NAME)
		})

		it("does nothing when the domain is already registered", async () => {
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(true)

			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: false })

			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("does nothing when the provider is disabled", async () => {
			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: false })

			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("enable() itself refuses to run while biometric lock is on", async () => {
			// The single gate covering every enable path — the settings screen (which collects
			// consent and flips biometric off first) AND the unattended ensureEncrypted
			// migration, which previously registered the domain ungated.
			mockSecureStoreData.set("biometric", { enabled: true })

			await expect(fileProvider.enable()).rejects.toThrow(/biometric/)

			expect(registerDomain).not.toHaveBeenCalled()
			expect(AUTH_FILE.exists).toBe(false)
		})

		it("removes a domain that landed while biometric lock is on", async () => {
			// A timed-out enable()'s uncancelled native registration can land AFTER the failure
			// was reported: biometric still on, domain registered. The reconcile repairs the
			// exclusivity invariant instead of ratifying it via the already-registered
			// early-return.
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()
			mockSecureStoreData.set("biometric", { enabled: true })
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(true)

			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: false })

			expect(unregisterDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER)
			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("removes an orphan domain when the provider is disabled", async () => {
			// A failed or timed-out unregister during disable/logout leaves a dead domain
			// serving notAuthenticated forever; the reconcile is the only thing that ever
			// repairs it.
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(true)

			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: false })

			expect(unregisterDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER)
			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("leaves the domain unregistered while biometric lock is on", async () => {
			// Registering arms Files.app to bypass the in-app biometric gate — the trade the
			// settings screen collects explicit consent for. The unattended startup reconcile
			// must never complete it silently.
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()
			vi.mocked(isDomainRegistered).mockResolvedValueOnce(false)
			mockSecureStoreData.set("biometric", { enabled: true })

			await expect(fileProvider.reconcileDomainRegistration()).resolves.toEqual({ freshlyRegistered: false })

			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("a stalled orphan probe does not unregister the domain a concurrent enable() registered", async () => {
			// The probes run outside writeMutex and can stall up to 15s. The probe result is
			// only a hint: the destructive call re-reads app state under the mutex, so an
			// enable() that completed in the stall window keeps its freshly registered domain.
			let probeStarted!: () => void
			const probeInFlight = new Promise<void>(resolve => {
				probeStarted = resolve
			})
			let resolveProbe!: (value: boolean) => void

			vi.mocked(isDomainRegistered).mockImplementationOnce(() => {
				probeStarted()

				return new Promise<boolean>(resolve => {
					resolveProbe = resolve
				})
			})

			// Provider disabled, stale domain apparently present — the orphan-repair shape.
			const reconcile = fileProvider.reconcileDomainRegistration()

			await probeInFlight
			await fileProvider.enable()

			resolveProbe(true)

			await expect(reconcile).resolves.toEqual({ freshlyRegistered: false })

			expect(unregisterDomain).not.toHaveBeenCalled()
			expect(await fileProvider.enabled()).toBe(true)
		})

		it("a stalled missing-domain probe does not re-register a domain a concurrent disable() removed", async () => {
			// The inverse race: the enabled-arm's probe stalls, a logout's disable() completes,
			// and a late registration would resurrect a domain with no credentials behind it —
			// a dead notAuthenticated location in Files.app.
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()
			vi.mocked(unregisterDomain).mockClear()

			let probeStarted!: () => void
			const probeInFlight = new Promise<void>(resolve => {
				probeStarted = resolve
			})
			let resolveProbe!: (value: boolean) => void

			vi.mocked(isDomainRegistered).mockImplementationOnce(() => {
				probeStarted()

				return new Promise<boolean>(resolve => {
					resolveProbe = resolve
				})
			})

			const reconcile = fileProvider.reconcileDomainRegistration()

			await probeInFlight
			await fileProvider.disable()

			resolveProbe(false)

			await expect(reconcile).resolves.toEqual({ freshlyRegistered: false })

			expect(registerDomain).not.toHaveBeenCalled()
			expect(AUTH_FILE.exists).toBe(false)
		})
	})

	describe("ensureEncrypted", () => {
		it("reports the migration's first registration so the Files.app hint can fire", async () => {
			// The migration cohort's enable() IS the first registration; the later reconcile
			// early-returns freshlyRegistered:false because the domain now exists. Swallowing
			// the flag here would permanently skip the hint for exactly that cohort.
			AUTH_FILE.create()
			AUTH_FILE.write("legacy-plaintext-not-decryptable")

			await expect(fileProvider.ensureEncrypted()).resolves.toEqual({ freshlyRegistered: true })

			expect(registerDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER, FILE_PROVIDER_DOMAIN_DISPLAY_NAME)
		})

		it("reports false when auth.json is already encrypted", async () => {
			await fileProvider.enable()
			vi.mocked(registerDomain).mockClear()

			await expect(fileProvider.ensureEncrypted()).resolves.toEqual({ freshlyRegistered: false })

			expect(registerDomain).not.toHaveBeenCalled()
		})

		it("reports false when the migration enable() fails", async () => {
			AUTH_FILE.create()
			AUTH_FILE.write("legacy-plaintext-not-decryptable")
			vi.mocked(registerDomain).mockRejectedValueOnce(new Error("fileproviderd wedged"))

			await expect(fileProvider.ensureEncrypted()).resolves.toEqual({ freshlyRegistered: false })
		})

		it("deletes an unreadable auth.json rather than leaving plaintext credentials at rest under a biometric lock", async () => {
			// enable() refuses while the biometric lock is on, and that refusal
			// never clears by itself — so a legacy plaintext auth.json would be
			// warn-and-retried every launch with apiKey/masterKeys in cleartext
			// inside a backed-up App Group container. Fail closed instead.
			AUTH_FILE.create()
			AUTH_FILE.write("legacy-plaintext-not-decryptable")
			mockSecureStoreData.set("biometric", { enabled: true })

			await expect(fileProvider.ensureEncrypted()).resolves.toEqual({ freshlyRegistered: false })

			expect(AUTH_FILE.exists).toBe(false)
			expect(unregisterDomain).toHaveBeenCalledWith(FILE_PROVIDER_DOMAIN_IDENTIFIER)
		})

		it("leaves a decryptable auth.json alone even when biometric is on", async () => {
			// The fail-closed path must be scoped to files that cannot be read;
			// a healthy provider config is not evidence of anything wrong.
			await fileProvider.enable()
			mockSecureStoreData.set("biometric", { enabled: true })
			vi.mocked(unregisterDomain).mockClear()

            await expect(fileProvider.ensureEncrypted()).resolves.toEqual({ freshlyRegistered: false })

			expect(AUTH_FILE.exists).toBe(true)
			expect(unregisterDomain).not.toHaveBeenCalled()
		})
	})
})
