import type * as sdk from "@filen/sdk-rs"

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
	| "PauseMode"
	| "SyncEventMessage_Tags"
	| "CacheStatusMessage_Tags"
	| "ResyncProgressMessage_Tags"
	| "SyncRefusal_Tags"
	| "WatchState"
	| "defaultSyncIgnorePatterns"
	| "init"
>

export type SyncEngine = sdk.JsSyncEngine
