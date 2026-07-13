import { requireNativeModule } from "expo-modules-core"
import { Platform } from "react-native"

// Android-only native bridge to the auth.json DEK (AndroidKeyStore-wrapped). On iOS the DEK lives in
// the Keychain via expo-secure-store, so these are never called there — we avoid requireNativeModule
// on iOS so the (absent) native module can't throw at import time.

type FilenAuthKeyNativeModule = {
	getOrCreateDek: () => Promise<string>
	purgeDek: () => Promise<void>
}

const native: FilenAuthKeyNativeModule | null =
	Platform.OS === "android" ? requireNativeModule<FilenAuthKeyNativeModule>("FilenAuthKey") : null

/** Provision (idempotent) the Keystore-wrapped DEK and return the raw 32-byte key, base64-encoded. */
export async function getOrCreateDek(): Promise<string> {
	if (!native) {
		throw new Error("FilenAuthKey native module is Android-only")
	}

	return native.getOrCreateDek()
}

/** Purge the wrapped DEK + its Keystore key. No-op off Android. */
export async function purgeDek(): Promise<void> {
	if (!native) {
		return
	}

	return native.purgeDek()
}
