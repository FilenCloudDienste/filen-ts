import crypto from "crypto"
import { Buffer } from "react-native-quick-crypto"

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

// AES-256-GCM, no AAD, laid out as [prefix byte] ++ iv(12) ++ ciphertext ++ authTag(16). The secureStore
// file and auth.json (read by the Rust cache's `decrypt_auth_bytes`) both pin this exact layout.
export function sealAesGcm(key: Uint8Array, plaintext: Uint8Array, prefix?: number): Uint8Array {
	const iv = crypto.randomBytes(IV_BYTES)
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
	const encrypted = cipher.update(plaintext)
	const final = cipher.final()
	const authTag = cipher.getAuthTag()
	const prefixLength = prefix === undefined ? 0 : 1

	// One output allocation; concat-then-copy would copy the full payload twice.
	const out = new Uint8Array(prefixLength + iv.length + encrypted.length + final.length + authTag.length)
	let offset = 0

	if (prefix !== undefined) {
		out[0] = prefix
		offset = 1
	}

	out.set(iv, offset)
	offset += iv.length
	out.set(encrypted, offset)
	offset += encrypted.length
	out.set(final, offset)
	offset += final.length
	out.set(authTag, offset)

	return out
}

// Opens a payload sealed by sealAesGcm, starting at `offset` (1 past a prefix byte). The caller has
// already checked the length covers iv + authTag. Throws when the auth tag fails (wrong key / tampered).
export function openAesGcm(key: Uint8Array, sealed: Uint8Array, offset: number) {
	const ivEnd = offset + IV_BYTES
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(offset, ivEnd))

	decipher.setAuthTag(sealed.subarray(sealed.length - AUTH_TAG_BYTES))

	const decrypted = decipher.update(sealed.subarray(ivEnd, sealed.length - AUTH_TAG_BYTES))
	const final = decipher.final()

	// GCM is a stream mode, so final() is empty for a single-update decrypt and the full-payload concat is skippable.
	return final.length === 0 ? decrypted : Buffer.concat([decrypted, final])
}
