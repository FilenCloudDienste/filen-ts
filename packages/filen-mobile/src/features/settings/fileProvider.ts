import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { Semaphore } from "@filen/utils"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"
import logger from "@/lib/logger"
import { getOrCreateAuthDek, purgeAuthDek, sealAuthFile, openAuthFile } from "@/features/settings/authFileKey"
import { atomicWrite } from "@/lib/fsAtomic"
import { registerDomain, unregisterDomain, isDomainRegistered } from "@/modules/file-provider-domain"

// Safety floor for cache budgets. Below this the extension would thrash —
// thumbnails alone need ~32 MiB to be useful.
const MIN_CACHE_BUDGET_BYTES = 64 * 1024 * 1024

// Ceiling on the memory ONE thumbnail decode may peak at, per platform. Not to be
// confused with maxThumbnailFilesBudget, which is disk for cached thumbnail files.
// Rust picks 12 MiB when this is absent, because that is what an iOS file provider
// extension survives: it has ~20 MiB before jetsam. Android's DocumentsProvider
// declares no android:process, so it runs in the app's own process with a normal
// heap and can afford the SDK's whole-process preset — without this it would inherit
// the extension's ceiling and refuse large HEIC/AVIF and wide PNGs it could decode
// comfortably. Mirrors microthumb's DEFAULT_MEM_BUDGET / APP_PROCESS_MEM_BUDGET.
const THUMBNAIL_MEM_BUDGET_BYTES = Platform.OS === "ios" ? 12 * 1024 * 1024 : 64 * 1024 * 1024

// secureStore key mirroring auth.json's `providerEnabled` field for fast,
// reactive UI reads via useSecureStore. enable() / disable() keep it in sync;
// the source of truth for the native extensions is still auth.json itself.
export const FILE_PROVIDER_ENABLED_SECURE_STORE_KEY = "fileProviderEnabled"

// The replicated iOS extension has no implicit default domain: unless the app registers one the
// system never instantiates it and nothing appears in Files.app. See
// modules/file-provider-domain/README.md.
export const FILE_PROVIDER_DOMAIN_IDENTIFIER = "io.filen.drive"
export const FILE_PROVIDER_DOMAIN_DISPLAY_NAME = "Filen"

// NSFileProviderManager.add/remove can hang outright (a crash-looping extension, fileproviderd
// under load, first-registration indexing). Both run inside writeMutex, so an unbounded hang
// would block every later enable()/disable() — including the disable() logout awaits. The mutex
// must never be held longer than this.
const DOMAIN_CALL_TIMEOUT_MS = 15_000

async function withDomainCallTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`${label} timed out after ${DOMAIN_CALL_TIMEOUT_MS}ms`))
				}, DOMAIN_CALL_TIMEOUT_MS)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

export const AUTH_FILE = new FileSystem.File(
	FileSystem.Paths.join(
		Platform.select({
			ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
			default: FileSystem.Paths.document
		}),
		"auth.json"
	)
)

if (Platform.OS === "ios" && !FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]) {
	logger.warn("file-provider", "App Group container not found — auth.json falling back to private Documents; file provider extension will not see the file", { groupId: IOS_APP_GROUP_IDENTIFIER })
}

// Mirrors the Rust `FilenSDKConfig` struct in filen-rs/filen-types/src/auth.rs.
// Every field is required — serde rejects the whole AuthFile if any of these
// is missing, which collapses the extension to "auth required".
export type TsSdkConfig = {
	email: string
	password: string
	twoFactorCode: string
	masterKeys: string[]
	apiKey: string
	publicKey: string
	privateKey: string
	authVersion: number
	baseFolderUUID: string
	userId: number
	metadataCache: boolean
	tmpPath: string
	connectToSocket: boolean
}

export type AuthFileSchema = {
	providerEnabled: boolean
	sdkConfig: TsSdkConfig | null
	maxThumbnailFilesBudget?: number | null
	maxCacheFilesBudget?: number | null
	thumbnailMemBudget?: number | null
}

class FileProvider {
	// Serializes auth.json writes. enable(), disable(), and setCacheBudget()
	// all touch the same file via this.write() — without the mutex, a slow
	// enable() racing setCacheBudget() can leave the JSON half-written or
	// drop fields.
	private writeMutex = new Semaphore(1)

	private async read(): Promise<AuthFileSchema | null> {
		if (!AUTH_FILE.exists) {
			return null
		}

		try {
			// auth.json is encrypted at rest — decrypt with the DEK before parsing. A legacy plaintext
			// file (or a lost DEK) fails openAuthFile and returns null, which ensureEncrypted() heals.
			const dek = await getOrCreateAuthDek()
			const json = openAuthFile(AUTH_FILE.bytesSync(), dek)

			return JSON.parse(json) as AuthFileSchema
		} catch (e) {
			logger.error("file-provider", "auth.json read/decrypt failed", { path: AUTH_FILE.uri, error: e })

			return null
		}
	}

	public async enabled(): Promise<boolean> {
		const data = await this.read()
		const enabled = data?.providerEnabled ?? false

		// Sync secureStore with auth.json's providerEnabled value on every read to ensure consistency for the native extensions
		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, enabled)

		return enabled
	}

	public async cacheBudget(): Promise<number> {
		const data = await this.read()

		if (!data || data.maxCacheFilesBudget == null || data.maxThumbnailFilesBudget == null) {
			return 1024 * 1024 * 1024
		}

		return Math.floor(data.maxCacheFilesBudget + data.maxThumbnailFilesBudget)
	}

	public async setCacheBudget(totalBytes: number): Promise<void> {
		if (!Number.isFinite(totalBytes) || totalBytes < MIN_CACHE_BUDGET_BYTES) {
			throw new Error(`Invalid cache budget: ${totalBytes}`)
		}

		const current = await this.read()

		if (!current) {
			throw new Error("setCacheBudget called before enable()")
		}

		// 25% thumbnails, 75% file cache — preserves the Rust default ratio
		// (256 MiB : 768 MiB). floor + subtraction guarantees thumb + cache === total
		// exactly, no rounding overshoot.
		const thumbnailBudget = Math.floor(totalBytes / 4)
		const cacheFileBudget = totalBytes - thumbnailBudget

		await this.write({
			...current,
			maxThumbnailFilesBudget: thumbnailBudget,
			maxCacheFilesBudget: cacheFileBudget
		} satisfies AuthFileSchema)
	}

	public async disable(): Promise<void> {
		// Inside writeMutex even though it is a slow system call: an enable() running concurrently
		// registers the domain inside its own critical section, so serializing on the mutex is what
		// guarantees no interleaving can leave the domain registered after this disable() deleted
		// the credentials (or vice versa). Unregistration comes before the delete so the extension
		// is never asked to serve a domain it can no longer authenticate for.
		await this.writeMutex.acquire()

		try {
			if (Platform.OS === "ios") {
				try {
					await withDomainCallTimeout(unregisterDomain(FILE_PROVIDER_DOMAIN_IDENTIFIER), "unregisterDomain")
				} catch (e) {
					// A stuck domain is a stale Files.app location, not a broken app — keep going and
					// still clear the credentials.
					logger.warn("file-provider", "file provider domain unregistration failed", { identifier: FILE_PROVIDER_DOMAIN_IDENTIFIER, error: e })
				}
			}

			if (AUTH_FILE.exists) {
				AUTH_FILE.delete()
			}
		} finally {
			this.writeMutex.release()
		}

		logger.info("file-provider", "file provider disabled — auth.json deleted")

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	}

	// Returns whether this call registered the domain for the first time (as opposed to it already
	// being registered): a freshly added NSFileProviderDomain lands disabled in Files.app, so callers
	// must surface the "enable Filen under Browse → Locations" step to the user exactly then.
	public async enable(): Promise<{ freshlyRegistered: boolean }> {
		// Hold writeMutex across the entire read -> getSdkClients -> write -> register
		// transaction. getSdkClients() is a real suspension point (slow on cold
		// start); without the lock a concurrent disable() or setCacheBudget()
		// could complete inside that await window and then be clobbered when
		// enable() resumes its write — re-creating auth.json after disable()
		// deleted it (provider silently re-enabled) or dropping a fresh budget.
		// Registration sits inside the critical section too: outside it, a
		// disable() could unregister-and-delete between our write and our
		// registration, and the registration would then resurrect a domain with
		// no credentials behind it.
		await this.writeMutex.acquire()

		let freshlyRegistered = false

		try {
			// The provider and biometric lock are mutually exclusive: the extension reads
			// auth.json directly, bypassing the in-app biometric gate. EVERY enable path funnels
			// through here (the settings screen, the ensureEncrypted migration), so this is the
			// single gate — callers that have collected consent turn biometric off FIRST (and
			// restore it if this call fails). Read INSIDE the mutex: enableBiometric()'s own
			// teardown calls disable() under this same mutex before it flips the flag, so a
			// pre-mutex read could pass the gate on a value a concurrent biometric enable was
			// about to change; under the mutex both orderings converge.
			const biometric = await secureStore.get<{ enabled: boolean }>("biometric")

			if (biometric?.enabled) {
				throw new Error("cannot enable the file provider while biometric lock is on")
			}

			const current = await this.read()
			const { authedSdkClient } = await auth.getSdkClients()
			const sdkConfig = authedSdkClient.toSdkConfig()
			// Provision the DEK before writing. If no secure hardware is available this throws and we
			// fail closed — the provider stays off and no plaintext auth.json is ever written.
			const dek = await getOrCreateAuthDek()

			this.writeUnlocked({
				...(current ? current : {}),
				providerEnabled: true,
				thumbnailMemBudget: THUMBNAIL_MEM_BUDGET_BYTES,
				sdkConfig: {
					email: sdkConfig.email,
					// The extension never re-authenticates from password/2FA — it only uses apiKey + masterKeys.
					// Forwarding the SDK's password to disk would be an unnecessary credential leak, so we hardcode
					// a placeholder. The Rust SDK accepts this once apiKey + masterKeys are present.
					password: "redacted",
					twoFactorCode: "redacted",
					masterKeys: sdkConfig.masterKeys,
					apiKey: sdkConfig.apiKey,
					publicKey: sdkConfig.publicKey,
					privateKey: sdkConfig.privateKey,
					authVersion: Number(sdkConfig.authVersion),
					baseFolderUUID: sdkConfig.baseFolderUuid,
					userId: Number(sdkConfig.userId),
					metadataCache: sdkConfig.metadataCache,
					tmpPath: sdkConfig.tmpPath,
					connectToSocket: sdkConfig.connectToSocket
				}
			} satisfies AuthFileSchema, dek)

			// After the write, so the extension finds credentials the moment the system brings it
			// up. A failure here propagates: swallowing it would report the provider as enabled
			// while no domain exists and nothing ever shows up in Files.app. auth.json stays
			// providerEnabled=true on purpose — reconcileDomainRegistration() retries the
			// registration on every authed startup until it sticks.
			if (Platform.OS === "ios") {
				// Under the same timeout as the register call: this is a fileproviderd XPC round
				// trip too, and it runs inside writeMutex — a wedged daemon here blocked every
				// later disable(), including the one logout awaits.
				freshlyRegistered = !(await withDomainCallTimeout(
					isDomainRegistered(FILE_PROVIDER_DOMAIN_IDENTIFIER),
					"isDomainRegistered"
				))

				await withDomainCallTimeout(
					registerDomain(FILE_PROVIDER_DOMAIN_IDENTIFIER, FILE_PROVIDER_DOMAIN_DISPLAY_NAME),
					"registerDomain"
				)
			}
		} finally {
			this.writeMutex.release()
		}

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, true)

		return { freshlyRegistered }
	}

	// Runs `action` under writeMutex with app state re-read inside the critical section. The
	// reconcile's domain probes run OUTSIDE the mutex (each can stall up to 15s; holding the mutex
	// across all of them would block a logout's disable() for ~45s), so by the time an action fires
	// its probe result may predate a concurrent enable()/disable() that held the mutex in between —
	// a stalled probe must not unregister the domain a fresh enable() just registered, nor
	// re-register one a disable() just removed. The probe is only a hint; `action` decides from the
	// re-read state, which no enable()/disable() can change until the mutex is released.
	private async withRecheckedState<T>(action: (state: { enabled: boolean; biometricOn: boolean }) => Promise<T>): Promise<T> {
		await this.writeMutex.acquire()

		try {
			const enabled = await this.enabled()
			const biometric = await secureStore.get<{ enabled: boolean }>("biometric")

			return await action({
				enabled,
				biometricOn: biometric?.enabled === true
			})
		} finally {
			this.writeMutex.release()
		}
	}

	// The registered domain is one-shot state the system can lose (crash-loop pause, system-side
	// removal), and the pre-replicated -> replicated update path never runs enable() at all when
	// auth.json is already readable — leaving the provider reported as enabled with no domain and,
	// before this existed, no retry path ever. Called on every authed startup: enabled but
	// unregistered -> register. Returns whether a fresh registration happened so the caller can
	// surface the Files.app enable step (a freshly added domain lands disabled there).
	public async reconcileDomainRegistration(): Promise<{ freshlyRegistered: boolean }> {
		if (Platform.OS !== "ios") {
			return { freshlyRegistered: false }
		}

		if (!(await this.enabled())) {
			// Repair the inverse desync too: a failed or timed-out unregister during
			// disable/logout leaves an orphan domain serving notAuthenticated forever — a dead
			// Files.app location nothing else ever removes.
			if (await withDomainCallTimeout(isDomainRegistered(FILE_PROVIDER_DOMAIN_IDENTIFIER), "isDomainRegistered")) {
				try {
					await this.withRecheckedState(async ({ enabled }) => {
						if (enabled) {
							// An enable() completed since the probe — the "orphan" is its
							// freshly registered domain. Leave it alone.
							return
						}

						logger.warn("file-provider", "provider disabled but the domain is still registered; removing it")

						await withDomainCallTimeout(unregisterDomain(FILE_PROVIDER_DOMAIN_IDENTIFIER), "unregisterDomain")
					})
				} catch (e) {
					logger.warn("file-provider", "orphan domain removal failed", { identifier: FILE_PROVIDER_DOMAIN_IDENTIFIER, error: e })
				}
			}

			return { freshlyRegistered: false }
		}

		// Registering the domain arms Files.app to read auth.json directly, which bypasses the
		// in-app biometric gate — the trade the settings screen collects explicit consent for
		// before enable(). This unattended path must not complete it silently, so the gate runs
		// BEFORE the already-registered early-return: a timed-out enable() whose uncancelled
		// native registration landed late is exactly the state where biometric is still on AND
		// the domain exists — that mismatch is repaired here by removing the domain, not ratified
		// by returning early. The settings screen's own consent flow is the way back in.
		const biometric = await secureStore.get<{ enabled: boolean }>("biometric")

		if (biometric?.enabled) {
			if (await withDomainCallTimeout(isDomainRegistered(FILE_PROVIDER_DOMAIN_IDENTIFIER), "isDomainRegistered")) {
				try {
					await this.withRecheckedState(async ({ biometricOn }) => {
						if (!biometricOn) {
							// The consent flow turned biometric off since the probe — the domain
							// belongs to the enable() that owns (or is about to own) it.
							return
						}

						logger.warn("file-provider", "domain registered while biometric lock is on; removing it to restore the exclusivity invariant")

						await withDomainCallTimeout(unregisterDomain(FILE_PROVIDER_DOMAIN_IDENTIFIER), "unregisterDomain")
					})
				} catch (e) {
					logger.warn("file-provider", "invariant-repair unregistration failed", { identifier: FILE_PROVIDER_DOMAIN_IDENTIFIER, error: e })
				}
			} else {
				logger.warn("file-provider", "provider enabled but biometric lock is on; leaving the domain unregistered until it is re-enabled with consent")
			}

			return { freshlyRegistered: false }
		}

		if (await withDomainCallTimeout(isDomainRegistered(FILE_PROVIDER_DOMAIN_IDENTIFIER), "isDomainRegistered")) {
			return { freshlyRegistered: false }
		}

		const registered = await this.withRecheckedState(async ({ enabled, biometricOn }) => {
			if (!enabled || biometricOn) {
				// A disable() or a biometric enable completed since the checks above —
				// registering now would resurrect a domain with no credentials behind it.
				return false
			}

			await withDomainCallTimeout(registerDomain(FILE_PROVIDER_DOMAIN_IDENTIFIER, FILE_PROVIDER_DOMAIN_DISPLAY_NAME), "registerDomain")

			return true
		})

		if (!registered) {
			return { freshlyRegistered: false }
		}

		logger.info("file-provider", "file provider domain was missing while enabled — re-registered", { identifier: FILE_PROVIDER_DOMAIN_IDENTIFIER })

		return { freshlyRegistered: true }
	}

	// Purges the auth.json DEK from the platform key store. Called on logout (after disable() deletes
	// auth.json) so no key material outlives the session.
	public async purgeKey(): Promise<void> {
		try {
			await purgeAuthDek()
		} catch (e) {
			logger.warn("file-provider", "auth DEK purge failed", { error: e })
		}
	}

	// One-time beta migration: if the provider is enabled but auth.json isn't a readable encrypted file
	// (legacy plaintext from before encryption, or a lost DEK), re-provision by re-running enable(),
	// which writes a fresh encrypted auth.json. Safe to call on every launch — no-ops when auth.json is
	// absent or already decryptable. Passes enable()'s freshlyRegistered through: for the migration
	// cohort this call IS the first registration, and the later reconcile's already-registered
	// early-return reports false — swallowing it here would permanently skip the Files.app hint for
	// exactly the users the hint was built for.
	public async ensureEncrypted(): Promise<{ freshlyRegistered: boolean }> {
		if (!AUTH_FILE.exists) {
			return { freshlyRegistered: false }
		}

		if ((await this.read()) !== null) {
			return { freshlyRegistered: false }
		}

		try {
			const { freshlyRegistered } = await this.enable()

			logger.info("file-provider", "auth.json migrated to encrypted format")

			return { freshlyRegistered }
		} catch (e) {
			// The biometric gate is the one failure that never clears by itself:
			// enable() refuses while the lock is on, so an unreadable (legacy
			// plaintext) auth.json would sit there being warn-and-retried every
			// launch, with apiKey/masterKeys/privateKey in cleartext inside a
			// backed-up App Group container. Fail CLOSED instead — drop the file
			// and the domain. Re-enabling is a deliberate act with consent; the
			// provider being off is the safe half of that trade.
			const biometric = await secureStore.get<{ enabled: boolean }>("biometric")

			if (biometric?.enabled) {
				logger.warn("file-provider", "cannot migrate auth.json while biometric lock is on — deleting the unreadable file rather than leaving credentials at rest", { error: e })

				try {
					await this.disable()
				} catch (disableError) {
					logger.error("file-provider", "failed to delete the unreadable auth.json", { error: disableError })
				}

				return { freshlyRegistered: false }
			}

			logger.warn("file-provider", "auth.json encryption migration failed — will retry next launch", { error: e })

			return { freshlyRegistered: false }
		}
	}

	private async write(data: AuthFileSchema): Promise<void> {
		await this.writeMutex.acquire()

		try {
			const dek = await getOrCreateAuthDek()

			this.writeUnlocked(data, dek)
		} finally {
			this.writeMutex.release()
		}
	}

	// Performs the actual auth.json replace, encrypting the payload with the DEK. Callers MUST already
	// hold writeMutex — this never acquires it, so it can be reused inside a longer locked transaction
	// (e.g. enable()) without deadlocking the single-permit Semaphore.
	private writeUnlocked(data: AuthFileSchema, dek: Uint8Array): void {
		// Write-temp-then-move instead of the old delete → create → write-in-place: the file
		// provider extension reads this file on its own schedule from another process, and the
		// in-place rewrite left a window where auth.json was missing or partial — states the
		// extension cannot tell apart from a disable/corruption. (The move is still not
		// crash-atomic — see fsAtomic — but the extension additionally re-confirms a disable
		// before acting destructively on one.)
		atomicWrite(AUTH_FILE, sealAuthFile(JSON.stringify(data, null, 4), dek))

		logger.info("file-provider", "auth.json written (encrypted)", { providerEnabled: data.providerEnabled, hasSdkConfig: data.sdkConfig !== null, maxCacheFilesBudget: data.maxCacheFilesBudget ?? null, maxThumbnailFilesBudget: data.maxThumbnailFilesBudget ?? null })
	}
}

const fileProvider = new FileProvider()

export default fileProvider
