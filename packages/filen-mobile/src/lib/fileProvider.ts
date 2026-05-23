import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"

// secureStore key mirroring auth.json's `providerEnabled` field for fast,
// reactive UI reads via useSecureStore. enable() / disable() keep it in sync;
// the source of truth for the native extensions is still auth.json itself.
export const FILE_PROVIDER_ENABLED_SECURE_STORE_KEY = "fileProviderEnabled"

// Legacy TS SDK config format
export type TsSdkConfig = {
	email?: string
	masterKeys?: string[]
	apiKey?: string
	publicKey?: string
	privateKey?: string
	authVersion?: number
	baseFolderUUID?: string
	userId?: number
}

export type AuthFileSchema = {
	providerEnabled: boolean
	sdkConfig: Required<TsSdkConfig> | null
	maxThumbnailFilesBudget?: number | null
	maxCacheFilesBudget?: number | null
}

class FileProvider {
	private readonly authFile: FileSystem.File = new FileSystem.File(
		FileSystem.Paths.join(
			Platform.select({
				ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				default: FileSystem.Paths.document
			}),
			"auth.json"
		)
	)

	private async read(): Promise<AuthFileSchema | null> {
		if (!this.authFile.exists) {
			return null
		}

		try {
			return JSON.parse(await this.authFile.text()) as AuthFileSchema
		} catch {
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

		if (!data || !data.maxCacheFilesBudget || !data.maxThumbnailFilesBudget) {
			return 1024 * 1024 * 1024
		}

		return Math.floor(data.maxCacheFilesBudget + data.maxThumbnailFilesBudget)
	}

	public async disable(): Promise<void> {
		if (this.authFile.exists) {
			this.authFile.delete()
		}

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	}

	public async enable(): Promise<void> {
		const current = await this.read()
		const { authedSdkClient } = await auth.getSdkClients()
		const sdkConfig = authedSdkClient.toSdkConfig()

		await this.write({
			...(current ? current : {}),
			providerEnabled: true,
			sdkConfig: {
				email: sdkConfig.email,
				masterKeys: sdkConfig.masterKeys,
				apiKey: sdkConfig.apiKey,
				publicKey: sdkConfig.publicKey,
				privateKey: sdkConfig.privateKey,
				authVersion: Number(sdkConfig.authVersion),
				baseFolderUUID: sdkConfig.baseFolderUuid,
				userId: Number(sdkConfig.userId)
			}
		} satisfies AuthFileSchema)

		await secureStore.set(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, true)
	}

	private async write(data: AuthFileSchema): Promise<void> {
		this.authFile.write(JSON.stringify(data), {
			encoding: "utf8"
		})
	}
}

const fileProvider = new FileProvider()

export default fileProvider
