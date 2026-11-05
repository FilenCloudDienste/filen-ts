import { requireOptionalNativeModule } from "expo-modules-core"
import { Platform } from "react-native"

// Android-only: the sdk-rs certificate verifier (the platform X509TrustManager over JNI) needs the JVM
// before the first connection (modules/filen-net/android/.../FilenTls.kt). iOS verifies through
// Security.framework and needs no init, so both calls report ready there. Optional, not required: a
// binary built without this module yields null rather than crashing at import; the SDK then fails its
// connections closed and reports why through tlsStatus().

type FilenNetNativeModule = {
	initTls: () => boolean
	tlsReady: () => boolean
}

const native: FilenNetNativeModule | null = Platform.OS === "android" ? requireOptionalNativeModule<FilenNetNativeModule>("FilenNet") : null

/** Initializes the platform TLS verifier once per process (idempotent). Returns whether it is ready. */
export function initTls(): boolean {
	if (Platform.OS !== "android") {
		return true
	}

	return native?.initTls() ?? false
}

/** Whether the platform TLS verifier was initialized, for diagnostics. */
export function tlsReady(): boolean {
	if (Platform.OS !== "android") {
		return true
	}

	return native?.tlsReady() ?? false
}
