import * as sdkRs from "@filen/sdk-rs"
import { tlsReady } from "@/modules/filen-net"
import logger from "@/lib/logger"

// The SDK's TLS self-report, uniffi `tlsStatus()`. Typed here rather than imported because the pinned
// @filen/sdk-rs predates it: against such a build the lookup below finds nothing and reports null.
// Replace with the generated `tlsStatus` / `TlsStatus` once the pin carries them.
export type SdkTlsStatus = {
	ready: boolean
	backend: unknown
	lastError: string | undefined
}

export function readSdkTlsStatus(): SdkTlsStatus | null {
	try {
		const sdkTlsStatus = (sdkRs as unknown as { tlsStatus?: () => SdkTlsStatus }).tlsStatus

		if (typeof sdkTlsStatus !== "function") {
			return null
		}

		return sdkTlsStatus()
	} catch (e) {
		logger.warn("sdkTls", "tlsStatus failed", { error: e })

		return null
	}
}

/** TLS state for the diagnostics export: the native init (Android) and the SDK's own report. */
export function tlsDiagnostics(): { nativeInit: boolean; sdk: SdkTlsStatus | null } {
	return {
		nativeInit: tlsReady(),
		sdk: readSdkTlsStatus()
	}
}
