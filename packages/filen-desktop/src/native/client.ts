import type { JsClient } from "@filen/sdk-rs"
import { parseSessionBlob } from "@filen/shared/session"
import type { NativeInit } from "../shared/nativeProtocol.ts"
import type { NativeSdk } from "./addon.ts"

// The host's one client, built offline from the vault's session blob; null when the blob is no session or its keys do
// not parse. Nothing here asks the server: a revoked session surfaces on the first engine call that does.
export function clientFromSession(sdk: NativeSdk, blob: string, logLevel: NativeInit["logLevel"]): JsClient | null {
	const session = parseSessionBlob(blob)

	if (session === null) {
		return null
	}

	try {
		const unauth = sdk.UnauthJsClient.fromConfig({ logLevel: logLevel === "Debug" ? sdk.LogLevel.Debug : sdk.LogLevel.Info })

		return unauth.fromStringified(session)
	} catch {
		return null
	}
}
