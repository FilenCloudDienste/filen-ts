import { tlsStatus, type TlsStatus } from "@filen/sdk-rs"
import { tlsReady } from "@/modules/filen-net"
import logger from "@/lib/logger"

// The SDK's TLS self-report; null when the call itself failed.
export function readSdkTlsStatus(): TlsStatus | null {
	try {
		return tlsStatus()
	} catch (e) {
		logger.warn("sdkTls", "tlsStatus failed", { error: e })

		return null
	}
}

/** TLS state for the diagnostics export: the native init (Android) and the SDK's own report. */
export function tlsDiagnostics(): { nativeInit: boolean; sdk: TlsStatus | null } {
	return {
		nativeInit: tlsReady(),
		sdk: readSdkTlsStatus()
	}
}
