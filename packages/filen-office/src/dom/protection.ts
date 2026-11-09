import {
	legacyPasswordBytes,
	legacyPasswordVerifier,
	legacyVerifierText,
	MAX_PROTECTION_SALT_BYTES,
	MAX_PROTECTION_SPIN_COUNT,
	protectionHashInputs,
	type DocumentProtectionHash,
	type ProtectionHash,
	type ProtectionHashName
} from "../core/docx/protection/hash"
import { constantTimeEqual, decodeBase64, encodeBase64, utf16LE } from "./encryption/bytes"
import { OfficeCryptoError } from "./encryption/errors"
import { randomBytes, subtle } from "./encryption/subtle"
import { turn, turnsOf, type OfficeCryptoOptions, type Turns } from "./encryption/turns"

// Checks a password against a protection hash (core/docx/protection/hash.ts) on the platform's WebCrypto:
// "password to modify" lifts a document's write protection for the session. Not a security boundary (the
// hash only gates an editor, [MS-OFFCRYPTO] §4.1.4), but the password is still never logged or kept, and the
// hashes compare in constant time. The spin gives the host a turn every few milliseconds (turns.ts), so it
// may run on a UI thread; the caller's signal stops it.

export type ProtectionVerdict = "correct" | "wrong" | "unsupported"

const DIGEST_BYTES: Readonly<Record<ProtectionHash["algorithm"], number>> = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 }
// Spin iterations between looks at the clock and the abort signal.
const SPIN_CHECK = 64

// Rejects with an OfficeCryptoError "aborted" when the signal fires; "unsupported" covers a hash or salt that
// is not base64 of the right size, a spin count that is not a whole number up to the 10,000,000 Office supports
// (a file's own count would otherwise spin without bound), and a platform without SubtleCrypto.
export async function verifyProtectionPassword(
	hash: ProtectionHash,
	password: string,
	options: OfficeCryptoOptions = {}
): Promise<ProtectionVerdict> {
	let expected: Uint8Array
	let salt: Uint8Array

	if (!Number.isInteger(hash.spinCount) || hash.spinCount < 0 || hash.spinCount > MAX_PROTECTION_SPIN_COUNT) return "unsupported"

	try {
		expected = decodeBase64(hash.hash)
		salt = decodeBase64(hash.salt)
	} catch (error) {
		if (error instanceof OfficeCryptoError) return "unsupported"

		throw error
	}

	if (expected.length !== DIGEST_BYTES[hash.algorithm] || salt.length > MAX_PROTECTION_SALT_BYTES) return "unsupported"

	const turns = turnsOf(options)

	try {
		for (const input of protectionHashInputs(hash, password)) {
			const encoded = utf16LE(input)
			const first = new Uint8Array(salt.length + encoded.length)

			first.set(salt)
			first.set(encoded, salt.length)
			encoded.fill(0)

			const found = await spin(hash, first, turns)
			const match = constantTimeEqual(found, expected)

			found.fill(0)

			if (match) return "correct"
		}
	} catch (error) {
		if (error instanceof OfficeCryptoError) {
			if (error.code === "aborted") throw error

			return "unsupported"
		}

		throw error
	}

	return "wrong"
}

// H0 = H(first), then Hn = H(Hn-1 + LE32(i)) for i < spinCount ([MS-OFFCRYPTO] §2.4.2.4). One buffer is
// reused: digest copies its input before it resolves.
async function spin(hash: ProtectionHash, first: Uint8Array, turns: Turns): Promise<Uint8Array> {
	const crypto = subtle()
	const size = DIGEST_BYTES[hash.algorithm]
	const buffer = new Uint8Array(size + 4)
	const view = new DataView(buffer.buffer)
	let h: Uint8Array

	try {
		h = new Uint8Array(await crypto.digest(hash.algorithm, first))
	} finally {
		first.fill(0)
	}

	try {
		for (let i = 0; i < hash.spinCount; i++) {
			buffer.set(h)
			view.setUint32(size, i, true)
			h.fill(0)
			h = new Uint8Array(await crypto.digest(hash.algorithm, buffer))

			if (i % SPIN_CHECK === SPIN_CHECK - 1) await turn(turns)
		}
	} catch (error) {
		h.fill(0)

		throw error
	} finally {
		buffer.fill(0)
	}

	return h
}

// Excel's own parameters for a new password hash (a sheet, the workbook): SHA-512, a 16-byte salt, 100,000 spins.
export const NEW_PROTECTION_SPIN_COUNT = 100_000
const NEW_PROTECTION_SALT_BYTES = 16

export interface NewProtectionHash {
	readonly algorithmName: "SHA-512"
	readonly hashValue: string
	readonly saltValue: string
	readonly spinCount: number
}

// The hash a protection with `password` is written with ([MS-OFFCRYPTO] §2.4.2.4: H0 = H(salt + UTF-16LE), then
// spun), base64 as SpreadsheetML writes it.
export async function hashProtectionPassword(password: string, options: OfficeCryptoOptions = {}): Promise<NewProtectionHash> {
	const salt = randomBytes(NEW_PROTECTION_SALT_BYTES)
	const encoded = utf16LE(password)
	const first = new Uint8Array(salt.length + encoded.length)

	first.set(salt)
	first.set(encoded, salt.length)
	encoded.fill(0)

	const found = await spin(
		{ algorithm: "SHA-512", hash: "", salt: "", spinCount: NEW_PROTECTION_SPIN_COUNT, input: "plain" },
		first,
		turnsOf(options)
	)

	try {
		return {
			algorithmName: "SHA-512",
			hashValue: encodeBase64(found),
			saltValue: encodeBase64(salt),
			spinCount: NEW_PROTECTION_SPIN_COUNT
		}
	} finally {
		found.fill(0)
	}
}

// Word's parameters for a document protection hash: SHA-1 (cryptAlgorithmSid 4), a 16-byte salt, 100,000 spins.
export const LEGACY_PROTECTION_SPIN_COUNT = 100_000
const LEGACY_PROTECTION_SALT_BYTES = 16

export interface LegacyProtectionHash {
	// base64Binary, as w:documentProtection's transitional w:hash and w:salt carry them.
	readonly hash: string
	readonly salt: string
	readonly spinCount: number
}

// The transitional w:documentProtection hash of a Word binary document's protection key (Dop lKeyProtDoc, the
// 32-bit legacy verifier of the password, [MS-OFFCRYPTO] §2.3.7.4): H0 = H(salt + UTF-16LE of the verifier as the
// upper-case hex of its little-endian bytes), spun as §2.4.2.4 says. The verifier is the input Word hashes for that
// attribute set (ECMA-376 1st ed. Part 4 §2.15.1.28), so the document asks for the same password as the original.
export async function hashLegacyProtectionKey(verifier: number, options: OfficeCryptoOptions = {}): Promise<LegacyProtectionHash> {
	const { hash, salt, spinCount } = await hashVerifier(verifier, "SHA-1", options)

	return { hash, salt, spinCount }
}

// The w:documentProtection hash Word 2013 and later write for `password` (Restrict Editing, Lock Tracking):
// SHA-512 (cryptAlgorithmSid 14), a 16-byte salt and 100,000 spins over the password's legacy verifier as Word
// writes its bytes (each UTF-16 unit's low byte, else its high one; truncated to 15, [MS-OFFCRYPTO] §2.3.7.4).
// An empty password takes no hash: the protection is written without one, as Word does.
export async function hashDocumentProtectionPassword(password: string, options: OfficeCryptoOptions = {}): Promise<DocumentProtectionHash> {
	const bytes = legacyPasswordBytes(password)
	const verifier = legacyPasswordVerifier(bytes[0] ?? new Uint8Array(0))

	for (const form of bytes) form.fill(0)

	return await hashVerifier(verifier, "SHA-512", options)
}

async function hashVerifier(
	verifier: number,
	algorithm: ProtectionHashName,
	options: OfficeCryptoOptions
): Promise<DocumentProtectionHash> {
	const salt = randomBytes(LEGACY_PROTECTION_SALT_BYTES)
	const encoded = utf16LE(legacyVerifierText(verifier >>> 0))
	const first = new Uint8Array(salt.length + encoded.length)

	first.set(salt)
	first.set(encoded, salt.length)
	encoded.fill(0)

	const found = await spin(
		{ algorithm, hash: "", salt: "", spinCount: LEGACY_PROTECTION_SPIN_COUNT, input: "legacy" },
		first,
		turnsOf(options)
	)

	try {
		return { algorithm, hash: encodeBase64(found), salt: encodeBase64(salt), spinCount: LEGACY_PROTECTION_SPIN_COUNT }
	} finally {
		found.fill(0)
	}
}
