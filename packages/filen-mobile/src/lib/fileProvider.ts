import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import auth from "@/lib/auth"

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

		return data?.providerEnabled ?? false
	}

	public async cacheBudget(): Promise<number> {
		const data = await this.read()

		if (!data || !data.maxCacheFilesBudget || !data.maxThumbnailFilesBudget) {
			return 1024 * 1024 * 1024
		}

		return Math.floor(data.maxCacheFilesBudget + data.maxThumbnailFilesBudget)
	}

	public async disable(): Promise<void> {
		if (!this.authFile.exists) {
			return
		}

		this.authFile.delete()
	}

	public async enable(): Promise<void> {
		const isAuthed = await auth.isAuthed()

		if (!isAuthed.isAuthed) {
			throw new Error("Cannot enable file provider when not authenticated")
		}

		const current = await this.read()

		await this.write({
			...(current ? current : {}),
			providerEnabled: true,
			sdkConfig: {
				email: isAuthed.stringifiedClient.email,
				masterKeys: [], // TODO: Fix
				apiKey: isAuthed.stringifiedClient.apiKey,
				publicKey: "", // TODO: Fix
				privateKey: isAuthed.stringifiedClient.privateKey,
				authVersion: isAuthed.stringifiedClient.authVersion,
				baseFolderUUID: isAuthed.stringifiedClient.rootUuid,
				userId: Number(isAuthed.stringifiedClient.userId)
			}
		} satisfies AuthFileSchema)
	}

	private async write(data: AuthFileSchema): Promise<void> {
		this.authFile.write(JSON.stringify(data), {
			encoding: "utf8"
		})
	}
}

const fileProvider = new FileProvider()

export default fileProvider
