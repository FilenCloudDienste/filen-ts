import { Platform } from "react-native"
import crypto from "crypto"
import { Buffer } from "react-native-quick-crypto"
import * as ExpoSecureStore from "expo-secure-store"
import { getOrCreateDek as androidGetOrCreateDek, purgeDek as androidPurgeDek } from "@/modules/filen-auth-key"

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
const IOS_DEK_ACCESS_GROUP = "7YTW5D2K7P.io.filen.sharedkeys"

const IOS_SECURE_STORE_OPTIONS: ExpoSecureStore.SecureStoreOptions = {
	keychainService: IOS_DEK_SERVICE,
	accessGroup: IOS_DEK_ACCESS_GROUP
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
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv)
	const encrypted = cipher.update(Buffer.from(plaintext, "utf-8"))
	const final = cipher.final()
	const authTag = cipher.getAuthTag()

	// Assemble version(1) ++ iv(12) ++ ciphertext ++ tag(16) with one allocation + .set() (mirrors
	// secureStore.ts — avoids Buffer/Uint8Array type juggling and double copies).
	const out = new Uint8Array(1 + iv.length + encrypted.length + final.length + authTag.length)
	let offset = 0
	out[offset] = AUTH_FILE_VERSION
	offset += 1
	out.set(iv, offset)
	offset += iv.length
	out.set(encrypted, offset)
	offset += encrypted.length
	out.set(final, offset)
	offset += final.length
	out.set(authTag, offset)

	return out
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

	const iv = sealed.subarray(1, 13)
	const ciphertext = sealed.subarray(13, sealed.length - 16)
	const authTag = sealed.subarray(sealed.length - 16)

	const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv)

	decipher.setAuthTag(authTag)

	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8")
}
