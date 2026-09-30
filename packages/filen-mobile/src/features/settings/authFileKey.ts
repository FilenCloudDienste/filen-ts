import { Platform } from "react-native"
import crypto from "crypto"
import { Buffer } from "react-native-quick-crypto"
import * as ExpoSecureStore from "expo-secure-store"
import { getOrCreateDek as androidGetOrCreateDek, purgeDek as androidPurgeDek } from "@/modules/filen-auth-key"
import { sealAesGcm, openAesGcm } from "@/lib/aesGcm"
import { IOS_KEYCHAIN_ACCESS_GROUP } from "@/lib/appIdentity"

// auth.json data-encryption key (DEK). A random 32-byte AES-256-GCM key that encrypts the
// provider's auth.json. Kept separate from the app's SecureStore key (no migration; least
// privilege — the extensions can decrypt ONLY auth.json).
//
// - iOS: the raw DEK (base64) lives in a dedicated, team-prefixed, shared Keychain access group so
//   the File Provider extension can read it via raw SecItemCopyMatching. These coordinates MUST
//   match FilenFileProviderExtension/FileProviderExtension.swift and the keychain-access-groups
//   entitlement on both the app and the extension.
// - Android: the Documents Provider runs same-UID, so a native module (modules/filen-auth-key)
//   wraps the DEK with a non-exportable AndroidKeyStore key and hands the raw bytes back here.

const DEK_BYTES = 32
const AUTH_FILE_VERSION = 0x01

const IOS_DEK_SERVICE = "io.filen.fileprovider"
const IOS_DEK_ACCOUNT = "fileProviderAuthKey"

const IOS_SECURE_STORE_OPTIONS: ExpoSecureStore.SecureStoreOptions = {
	keychainService: IOS_DEK_SERVICE,
	accessGroup: IOS_KEYCHAIN_ACCESS_GROUP
}

/**
 * Returns the raw 32-byte auth.json DEK, provisioning it if absent. Stable across enable/disable —
 * only purged on logout. Throws when no secure key store is available (caller fails closed and does
 * NOT write auth.json; never a static-key fallback).
 */
export async function getOrCreateAuthDek(): Promise<Uint8Array> {
	if (Platform.OS === "ios") {
		const existing = await ExpoSecureStore.getItemAsync(IOS_DEK_ACCOUNT, IOS_SECURE_STORE_OPTIONS)

		if (existing) {
			return Buffer.from(existing, "base64")
		}

		const dek = crypto.randomBytes(DEK_BYTES)

		await ExpoSecureStore.setItemAsync(IOS_DEK_ACCOUNT, dek.toString("base64"), {
			...IOS_SECURE_STORE_OPTIONS,
			// Readable by the background File Provider after the first post-boot unlock; never syncs
			// or migrates to another device.
			keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
		})

		return dek
	}

	// Android: native module provisions (Keystore-wrapped) and returns the raw DEK base64-encoded.
	const base64 = await androidGetOrCreateDek()

	return Buffer.from(base64, "base64")
}

/** Purges the DEK from the platform key store. Called on logout. Best-effort. */
export async function purgeAuthDek(): Promise<void> {
	if (Platform.OS === "ios") {
		await ExpoSecureStore.deleteItemAsync(IOS_DEK_ACCOUNT, IOS_SECURE_STORE_OPTIONS)

		return
	}

	await androidPurgeDek()
}

/**
 * Seals the auth.json payload into the exact on-disk format the Rust cache (`decrypt_auth_bytes`)
 * expects: version(0x01) ++ iv(12) ++ ciphertext ++ authTag(16), AES-256-GCM, no AAD.
 */
export function sealAuthFile(plaintext: string, dek: Uint8Array): Uint8Array {
	return sealAesGcm(dek, Buffer.from(plaintext, "utf-8"), AUTH_FILE_VERSION)
}

/**
 * Opens an auth.json blob produced by {@link sealAuthFile}. Throws on unrecognized format/version or
 * a failed authentication tag (wrong key / tampered / legacy plaintext) — callers treat a throw as
 * "not readable" and fall back accordingly.
 */
export function openAuthFile(sealed: Uint8Array, dek: Uint8Array): string {
	if (sealed.length < 1 + 12 + 16 || sealed[0] !== AUTH_FILE_VERSION) {
		throw new Error("unrecognized auth file format")
	}

	return openAesGcm(dek, sealed, 1).toString("utf-8")
}
