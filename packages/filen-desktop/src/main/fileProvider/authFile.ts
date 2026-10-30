import { parseSessionBlob } from "@filen/shared/session"

// The ceiling one thumbnail decode in the extension may peak at, as on iOS (an extension is killed far below an app).
export const THUMBNAIL_MEM_BUDGET_BYTES = 12 * 1024 * 1024

// One domain per account, so another account never reuses one.
export function domainIdentifier(userId: string): string {
	return `io.filen.drive.${userId}`
}

// What the extension gets for a session. `json` is the AuthFile (filen-types' FilenSDKConfig) and holds the keys: it is
// never logged and never put in an error.
export interface FileProviderAuth {
	userId: string
	// The domain's name; Finder names the CloudStorage directory after it, as other providers do with the account.
	displayName: string
	json: string
}

// The vault's session blob field by field; null when it is not a session. The extension never signs in, so the password
// and 2FA code are placeholders, and it keeps its own cache and socket settings.
export function fileProviderAuth(blob: string): FileProviderAuth | null {
	const session = parseSessionBlob(blob)

	if (session === null) {
		return null
	}

	return {
		userId: session.userId.toString(),
		displayName: session.email,
		json: JSON.stringify({
			providerEnabled: true,
			sdkConfig: {
				email: session.email,
				password: "redacted",
				twoFactorCode: "redacted",
				masterKeys: session.authInfo.split("|"),
				apiKey: session.apiKey,
				publicKey: "",
				privateKey: session.privateKey,
				authVersion: session.authVersion,
				baseFolderUUID: session.rootUuid,
				userId: Number(session.userId),
				metadataCache: false,
				tmpPath: "",
				connectToSocket: false
			},
			thumbnailMemBudget: THUMBNAIL_MEM_BUDGET_BYTES
		})
	}
}
