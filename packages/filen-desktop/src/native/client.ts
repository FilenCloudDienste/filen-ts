import type { JsClient } from "@filen/sdk-rs"
import type { DesktopSpeed } from "@filen/shared/desktop"
import { parseSessionBlob } from "@filen/shared/session"
import type { NativeInit } from "../shared/nativeProtocol.ts"
import type { NativeSdk } from "./addon.ts"
import { speedConfig } from "./speed.ts"

// The host's two clients, built offline from the vault's session blob: `sync` (the cache, the sync engine and the
// socket) and `transfers` (the drive's uploads and downloads and rclone). Each comes from its own UnauthJsClient:
// clients descended from one share its state (chunk gate, limiters, memory budget), so neither would have its own
// speed. null when the blob is no session or its keys do not parse. Nothing here asks the server: a revoked session
// surfaces on the first call that does.
export function clientsFromSession(
	sdk: NativeSdk,
	blob: string,
	logLevel: NativeInit["logLevel"],
	speed: DesktopSpeed
): { sync: JsClient; transfers: JsClient } | null {
	const session = parseSessionBlob(blob)

	if (session === null) {
		return null
	}

	const level = logLevel === "Debug" ? sdk.LogLevel.Debug : sdk.LogLevel.Info

	try {
		return {
			sync: sdk.UnauthJsClient.fromConfig({ logLevel: level, ...speedConfig(speed.sync) }).fromStringified(session),
			transfers: sdk.UnauthJsClient.fromConfig({ logLevel: level, ...speedConfig(speed.transfers) }).fromStringified(session)
		}
	} catch {
		return null
	}
}
