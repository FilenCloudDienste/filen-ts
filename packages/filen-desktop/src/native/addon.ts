import { createRequire } from "node:module"
import type * as sdk from "@filen/sdk-rs"
import type { DesktopSyncMode } from "@filen/shared/desktop"

// The addon's runtime surface the host uses. Values come from the loaded `.node` (it registers its own enums and tag
// objects); `@filen/sdk-rs` resolves to its napi typings through the `filen-desktop` condition and is never bundled.
export type NativeSdk = Pick<
	typeof sdk,
	| "UnauthJsClient"
	| "FilenSdkError"
	| "SyncMode"
	| "Backlog"
	| "ConflictResolution"
	| "ErrorKind"
	| "LogLevel"
	| "PauseMode"
	| "PlannedNodeKind"
	| "RefuseReason"
	| "TransferDirection"
	| "SyncEventMessage_Tags"
	| "CacheStatusMessage_Tags"
	| "ResyncProgressMessage_Tags"
	| "SyncRefusal_Tags"
	| "WatchState"
	| "ServeProtocol"
	| "defaultSyncIgnorePatterns"
	| "init"
	| "rcloneAvailableDriveLetters"
	| "rcloneClearCache"
	| "rcloneForceUnmount"
	| "rcloneRecoverStale"
	| "rcloneStopUnder"
>

export type SyncEngine = sdk.JsSyncEngine

// Throws when the file is missing or not a loadable addon for this process.
export function loadAddon(path: string): NativeSdk {
	return createRequire(import.meta.url)(path) as NativeSdk
}

export function modeName(addon: NativeSdk, mode: sdk.SyncMode): DesktopSyncMode {
	switch (mode) {
		case addon.SyncMode.LocalToRemote:
			return "localToRemote"
		case addon.SyncMode.RemoteToLocal:
			return "remoteToLocal"
		case addon.SyncMode.LocalBackup:
			return "localBackup"
		case addon.SyncMode.RemoteBackup:
			return "remoteBackup"
		default:
			return "twoWay"
	}
}

export function syncMode(addon: NativeSdk, mode: DesktopSyncMode): sdk.SyncMode {
	switch (mode) {
		case "localToRemote":
			return addon.SyncMode.LocalToRemote
		case "remoteToLocal":
			return addon.SyncMode.RemoteToLocal
		case "localBackup":
			return addon.SyncMode.LocalBackup
		case "remoteBackup":
			return addon.SyncMode.RemoteBackup
		case "twoWay":
			return addon.SyncMode.TwoWay
	}
}
