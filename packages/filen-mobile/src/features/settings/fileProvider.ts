import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { Semaphore } from "@filen/utils"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"
import logger from "@/lib/logger"

// Safety floor for cache budgets. Below this the extension would thrash —
// thumbnails alone need ~32 MiB to be useful.
const MIN_CACHE_BUDGET_BYTES = 64 * 1024 * 1024

// secureStore key mirroring auth.json's `providerEnabled` field for fast,
// reactive UI reads via useSecureStore. enable() / disable() keep it in sync;
// the source of truth for the native extensions is still auth.json itself.
export const FILE_PROVIDER_ENABLED_SECURE_STORE_KEY = "fileProviderEnabled"

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
			return JSON.parse(await AUTH_FILE.text()) as AuthFileSchema
		} catch (e) {
			logger.error("file-provider", "auth.json parse failed — file corrupt or truncated", { path: AUTH_FILE.uri, error: e })

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
		await this.writeMutex.acquire()

		try {
			if (AUTH_FILE.exists) {
				AUTH_FILE.delete()
			}
		} finally {
			this.writeMutex.release()
		}

		logger.info("file-provider", "file provider disabled — auth.json deleted")

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	}

	public async enable(): Promise<void> {
		// Hold writeMutex across the entire read -> getSdkClients -> write
		// transaction. getSdkClients() is a real suspension point (slow on cold
		// start); without the lock a concurrent disable() or setCacheBudget()
		// could complete inside that await window and then be clobbered when
		// enable() resumes its write — re-creating auth.json after disable()
		// deleted it (provider silently re-enabled) or dropping a fresh budget.
		await this.writeMutex.acquire()

		try {
			const current = await this.read()
			const { authedSdkClient } = await auth.getSdkClients()
			const sdkConfig = authedSdkClient.toSdkConfig()

			this.writeUnlocked({
				...(current ? current : {}),
				providerEnabled: true,
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
			} satisfies AuthFileSchema)
		} finally {
			this.writeMutex.release()
		}

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, true)
	}

	private async write(data: AuthFileSchema): Promise<void> {
		await this.writeMutex.acquire()

		try {
			this.writeUnlocked(data)
		} finally {
			this.writeMutex.release()
		}
	}

	// Performs the actual auth.json replace. Callers MUST already hold writeMutex —
	// this never acquires it, so it can be reused inside a longer locked transaction
	// (e.g. enable()) without deadlocking the single-permit Semaphore.
	private writeUnlocked(data: AuthFileSchema): void {
		if (AUTH_FILE.exists) {
			AUTH_FILE.delete()
		}

		AUTH_FILE.create()

		AUTH_FILE.write(JSON.stringify(data, null, 4))

		logger.info("file-provider", "auth.json written", { providerEnabled: data.providerEnabled, hasSdkConfig: data.sdkConfig !== null, maxCacheFilesBudget: data.maxCacheFilesBudget ?? null, maxThumbnailFilesBudget: data.maxThumbnailFilesBudget ?? null })
	}
}

const fileProvider = new FileProvider()

export default fileProvider
