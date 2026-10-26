import { constantTimeEqual, md5, Rc4 } from "../crypto/legacy"
import { legacyPasswordBytes, legacyPasswordVerifier } from "../docx/protection/hash"
import { le16, le32 } from "./bytes"
import { DocError, corrupt } from "./errors"

// Password to open on a Word 97–2003 document ([MS-DOC] §2.2.6): XOR obfuscation ([MS-OFFCRYPTO] §2.3.7), RC4
// (§2.3.6) and CryptoAPI RC4 (§2.3.5). Read-only: the password is checked against the file's verifier first, then the
// WordDocument, Table and Data streams are decrypted into new arrays (a source's bytes are never written). Key
// material is wiped once a stream is done; the password itself is a string and cannot be.

export type DocCipherScheme = "xor" | "rc4" | "cryptoApiRc4"

export interface DocDecryption {
	readonly password: string
	// SHA-1 (CryptoAPI RC4 keys): the platform's WebCrypto where the conversion runs.
	sha1(data: Uint8Array): Promise<Uint8Array>
}

// A verified password's key for one file.
export interface DocKey {
	readonly scheme: DocCipherScheme
	// `input` (a whole stream) decrypted into a new array; its first `clear` bytes are copied as they are.
	decrypt(input: Uint8Array, clear: number): Promise<Uint8Array>
	wipe(): void
}

// A CryptoAPI RC4 key that also decrypts a range as one key stream from a block key ([MS-PPT] §2.3.7: a persist object
// with its persist id as the block number, each Pictures-stream field with block 0).
export interface DocBlockKey extends DocKey {
	// `input` decrypted into a new array with the key of `block`, never rekeyed.
	decryptBlock(input: Uint8Array, block: number): Promise<Uint8Array>
}

// [MS-DOC] §2.2.6.1–§2.2.6.3: FibBase (68 bytes) stays clear; RC4 rekeys every 512 bytes from the stream's start.
export const CLEAR_WORD_BYTES = 68
const BLOCK = 512

// Where the key derivation is shared with another binary format: the bytes RC4 rekeys after ([MS-XLS] §2.2.10: 1024).
export interface DocKeyOptions {
	readonly block?: number
}
// §2.3.6.2 and §2.3.5.2: at most 255 Unicode characters.
const MAX_PASSWORD = 255
const SALT = 16
const RC4_HEADER = 4 + 3 * SALT
const SHA1_BYTES = 20
// CryptoAPI keys computed per await (one SHA-1 each).
const KEY_BATCH = 256

function wrong(): DocError {
	return new DocError("wrongPassword", "the password is not correct")
}

function utf16le(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2)

	for (let k = 0; k < text.length; k++) {
		const unit = text.charCodeAt(k)

		out[2 * k] = unit & 0xff
		out[2 * k + 1] = unit >>> 8
	}

	return out
}

function le32Bytes(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

// The key for `scheme` checked against the file's verifier: a DocError "wrongPassword" when it does not match, "corrupt"
// when the EncryptionHeader is malformed, "encrypted" (unknown) for an RC4 CryptoAPI variant this reader does not do.
// `table` is the raw Table stream; `lKey` is FibBase.lKey.
export async function docKey(
	scheme: DocCipherScheme,
	lKey: number,
	table: Uint8Array,
	decryption: DocDecryption,
	options: DocKeyOptions = {}
): Promise<DocKey> {
	if (decryption.password.length > MAX_PASSWORD) throw wrong()

	// The EncryptionHeader lies inside the Table stream ([MS-DOC] §2.2.6.2–§2.2.6.3).
	if (scheme !== "xor" && lKey > table.length) throw corrupt("FibBase.lKey points past the Table stream")

	switch (scheme) {
		case "xor":
			return xorKey(lKey, decryption.password)
		case "rc4":
			return rc4Key(lKey, table, decryption.password, options.block ?? BLOCK)
		case "cryptoApiRc4":
			return cryptoApiKey(lKey, table, decryption, options.block ?? BLOCK)
	}
}

// The RC4 CryptoAPI key of an EncryptionHeader that stands alone ([MS-OFFCRYPTO] §2.3.5.1; a PowerPoint
// CryptSession10Container's data), checked against its verifier. The same DocErrors as docKey.
export async function cryptoApiBlockKey(header: Uint8Array, decryption: DocDecryption): Promise<DocBlockKey> {
	if (decryption.password.length > MAX_PASSWORD) throw wrong()

	return cryptoApiKey(header.length, header, decryption, BLOCK)
}

// --- XOR obfuscation ---

const PAD = Uint8Array.of(0xbb, 0xff, 0xff, 0xba, 0xff, 0xff, 0xb9, 0x80, 0x00, 0xbe, 0x0f, 0x00, 0xbf, 0x0f, 0x00)

function xorRor(a: number, b: number): number {
	const value = (a ^ b) & 0xff

	return ((value >>> 1) | (value << 7)) & 0xff
}

// CreateXorArray_Method1 (§2.3.7.2) of a single-byte password of 1 to 15 bytes and its XorKey.
function xorArray(password: Uint8Array, key: number): Uint8Array {
	const high = (key >>> 8) & 0xff
	const low = key & 0xff
	const out = new Uint8Array(16)
	let index = password.length

	if (index % 2 === 1) {
		out[index] = xorRor(PAD[0] ?? 0, high)
		index--
		out[index] = xorRor(password[password.length - 1] ?? 0, low)
	}

	while (index > 0) {
		index--
		out[index] = xorRor(password[index] ?? 0, high)
		index--
		out[index] = xorRor(password[index] ?? 0, low)
	}

	for (let at = 15, pad = 15 - password.length; pad > 0;) {
		out[at--] = xorRor(PAD[pad--] ?? 0, high)
		out[at--] = xorRor(PAD[pad--] ?? 0, low)
	}

	return out
}

// The XorArray (§2.3.7.2) of the single-byte form of `password` whose CreatePasswordVerifier_Method2 (§2.3.7.4: XorKey
// high, verifier low) is `lKey`; a DocError "wrongPassword" when none is.
export function xorObfuscationArray(lKey: number, password: string): Uint8Array {
	if (password.length === 0) throw wrong()

	let array: Uint8Array | undefined

	// §2.3.7.4: every single-byte form of the password is tried (each is computed, whatever matches).
	for (const candidate of legacyPasswordBytes(password)) {
		const verifier = legacyPasswordVerifier(candidate)

		if (verifier === lKey >>> 0 && array === undefined) array = xorArray(candidate, verifier >>> 16)

		candidate.fill(0)
	}

	if (array === undefined) throw wrong()

	return array
}

// [MS-DOC] §2.2.6.1: FibBase.lKey holds CreatePasswordVerifier_Method2 (§2.3.7.4); the streams went through XOR Data
// Transformation Method 2 (§2.3.7.6), indexed from the start of each stream.
function xorKey(lKey: number, password: string): DocKey {
	const key = xorObfuscationArray(lKey, password)

	return {
		scheme: "xor",
		decrypt(input, clear) {
			const out = new Uint8Array(input.length)

			out.set(input.subarray(0, clear))

			for (let k = Math.min(clear, input.length); k < input.length; k++) {
				const byte = input[k] ?? 0
				const mask = key[k & 15] ?? 0

				// A byte that is 0x00, or equal to its mask, was left as it was.
				out[k] = byte === 0 || byte === mask ? byte : byte ^ mask
			}

			return Promise.resolve(out)
		},
		wipe() {
			key.fill(0)
		}
	}
}

// --- RC4 (block cipher stream per 512 bytes) ---

function rc4Stream(
	scheme: "rc4" | "cryptoApiRc4",
	block: number,
	blockKeys: (first: number, count: number) => Promise<Uint8Array[]>,
	wipe: () => void
): DocKey {
	return {
		scheme,
		async decrypt(input, clear) {
			const out = new Uint8Array(input.length)
			const blocks = Math.ceil(input.length / block)

			for (let first = 0; first < blocks; first += KEY_BATCH) {
				const keys = await blockKeys(first, Math.min(KEY_BATCH, blocks - first))

				keys.forEach((key, k) => {
					const at = (first + k) * block
					const cipher = new Rc4(key)

					cipher.apply(input, out, at, at, Math.min(block, input.length - at))
					cipher.wipe()
					key.fill(0)
				})
			}

			out.set(input.subarray(0, Math.min(clear, input.length)))

			return out
		},
		wipe
	}
}

// §2.3.6.1 RC4 EncryptionHeader: Version 1.1, Salt, EncryptedVerifier, EncryptedVerifierHash (16 bytes each).
// §2.3.6.2: H0 = MD5(password), H1 = MD5(16 × (H0[0..5] + salt)), key(block) = MD5(H1[0..5] + block).
async function rc4Key(lKey: number, table: Uint8Array, password: string, blockSize: number): Promise<DocKey> {
	if (lKey < RC4_HEADER || table.length < RC4_HEADER) throw corrupt("the RC4 EncryptionHeader is truncated")

	const salt = table.subarray(4, 4 + SALT)
	const encoded = utf16le(password)
	const h0 = md5(encoded)
	const buffer = new Uint8Array(16 * (5 + SALT))

	encoded.fill(0)

	for (let k = 0; k < 16; k++) {
		buffer.set(h0.subarray(0, 5), k * (5 + SALT))
		buffer.set(salt, k * (5 + SALT) + 5)
	}

	// The whole digest is held so all of it is wiped; the key uses its first 5 bytes.
	const digest1 = md5(buffer)
	const h1 = digest1.subarray(0, 5)

	h0.fill(0)
	buffer.fill(0)

	const blockKey = (block: number): Uint8Array => md5(h1, le32Bytes(block))
	const check = new Uint8Array(2 * SALT)
	const key0 = blockKey(0)
	const cipher = new Rc4(key0)

	key0.fill(0)

	// §2.3.6.4: one key stream over the verifier, then its hash.
	cipher.apply(table, check, 4 + SALT, 0, 2 * SALT)
	cipher.wipe()

	const verifier = check.subarray(0, SALT)
	const hash = md5(verifier)
	const ok = constantTimeEqual(hash, check.subarray(SALT))

	check.fill(0)
	hash.fill(0)

	if (!ok) {
		digest1.fill(0)

		throw wrong()
	}

	return rc4Stream(
		"rc4",
		blockSize,
		(first, count) => Promise.resolve(Array.from({ length: count }, (_, k) => blockKey(first + k))),
		() => digest1.fill(0)
	)
}

// §2.3.5.1 RC4 CryptoAPI EncryptionHeader: Version (2|3|4).2, Flags, EncryptionHeaderSize, EncryptionHeader (§2.3.2:
// AlgID RC4, AlgIDHash SHA-1, KeySize 40–128 bits), EncryptionVerifier (§2.3.3: 16-byte salt and verifier, 20-byte
// verifier hash). §2.3.5.2: H0 = SHA-1(salt + password), key(block) = SHA-1(H0 + block) cut to KeySize; a 40-bit key is
// padded with zeros to 128 bits.
// What makes an RC4 CryptoAPI EncryptionHeader and EncryptionVerifier unreadable ([MS-OFFCRYPTO] §2.3.5.1, §2.3.3) within
// the first `lKey` bytes of the Table stream, else undefined. The structure is checked without the password, so a
// damaged file is refused before one is asked for; only the verifier's hash needs the key.
export function cryptoApiHeaderProblem(table: Uint8Array, lKey: number): string | undefined {
	const end = Math.min(lKey, table.length)

	if (end < 12) return "the RC4 CryptoAPI EncryptionHeader is truncated"

	const headerSize = le32(table, 8)
	const verifierAt = 12 + headerSize

	if (headerSize < 32 || verifierAt + 4 + SALT + SALT + 4 + SHA1_BYTES > end) return "the RC4 CryptoAPI EncryptionHeader is truncated"

	// Another cipher is no damage: it is told apart as such (cryptoApiCipher).
	if (cryptoApiCipher(table, end) === "other") return undefined

	const keySize = le32(table, 12 + 16) || 40

	if (keySize < 40 || keySize > 128 || keySize % 8 !== 0) return `RC4 CryptoAPI KeySize ${keySize}`

	const saltSize = le32(table, verifierAt)
	const hashSize = le32(table, verifierAt + 4 + SALT + SALT)

	if (saltSize !== SALT || hashSize !== SHA1_BYTES) return "the RC4 CryptoAPI EncryptionVerifier is malformed"

	return undefined
}

async function cryptoApiKey(lKey: number, table: Uint8Array, decryption: DocDecryption, blockSize: number): Promise<DocBlockKey> {
	const end = lKey
	const problem = cryptoApiHeaderProblem(table, lKey)

	if (problem !== undefined) throw corrupt(problem)

	if (cryptoApiCipher(table, end) === "other")
		throw new DocError("encrypted", "a CryptoAPI cipher other than RC4 with SHA-1", { encryption: "unknown" })

	const headerSize = le32(table, 8)
	const verifierAt = 12 + headerSize
	const keySize = le32(table, 12 + 16) || 40

	const salt = table.subarray(verifierAt + 4, verifierAt + 4 + SALT)
	const encoded = utf16le(decryption.password)
	const input = new Uint8Array(SALT + encoded.length)

	input.set(salt)
	input.set(encoded, SALT)
	encoded.fill(0)

	const h0 = await decryption.sha1(input)

	input.fill(0)

	let wiped = false
	const blockKey = async (block: number): Promise<Uint8Array> => {
		// A wiped key's h0 is zeros: decrypting with it would give garbage, not an error.
		if (wiped) throw new Error("the CryptoAPI key was wiped")

		const seed = new Uint8Array(h0.length + 4)

		seed.set(h0)
		seed.set(le32Bytes(block), h0.length)

		const hash = await decryption.sha1(seed)
		const key = new Uint8Array(16)

		seed.fill(0)
		key.set(hash.subarray(0, keySize / 8))
		hash.fill(0)

		// 40 bits: the rest of the 128-bit key stays zero; otherwise the key is KeySize bits long.
		return keySize === 40 ? key : key.subarray(0, keySize / 8)
	}
	const check = new Uint8Array(SALT + SHA1_BYTES)
	const key0 = await blockKey(0)
	const cipher = new Rc4(key0)

	key0.fill(0)

	cipher.apply(table, check, verifierAt + 4 + SALT, 0, SALT)
	cipher.apply(table, check, verifierAt + 4 + SALT + SALT + 4, SALT, SHA1_BYTES)
	cipher.wipe()

	const hash = await decryption.sha1(check.subarray(0, SALT))
	const ok = constantTimeEqual(hash, check.subarray(SALT))

	check.fill(0)
	hash.fill(0)

	if (!ok) {
		h0.fill(0)

		throw wrong()
	}

	const stream = rc4Stream(
		"cryptoApiRc4",
		blockSize,
		(first, count) => Promise.all(Array.from({ length: count }, (_, k) => blockKey(first + k))),
		() => {
			wiped = true
			h0.fill(0)
		}
	)

	return {
		...stream,
		async decryptBlock(input, block) {
			const out = new Uint8Array(input.length)
			const key = await blockKey(block)
			const cipher = new Rc4(key)

			key.fill(0)
			cipher.apply(input, out, 0, 0, input.length)
			cipher.wipe()

			return out
		}
	}
}

// The EncryptionHeader's version says which RC4 the file uses (§2.2.6.2–§2.2.6.3); XOR when fObfuscated.
export function docCipherScheme(fObfuscated: boolean, table: Uint8Array | undefined): DocCipherScheme | "unknown" {
	if (fObfuscated) return "xor"

	if (table === undefined || table.length < 4) return "unknown"

	const major = le16(table, 0)
	const minor = le16(table, 2)

	if (major === 1 && minor === 1) return "rc4"
	// RC4 CryptoAPI only when its EncryptionHeader names RC4 with SHA-1 ([MS-OFFCRYPTO] §2.3.5.1, §2.3.2): another
	// CryptoAPI cipher is told apart before any password is asked for.
	// A malformed header is still RC4 CryptoAPI by its version: the key derivation refuses it as damaged.
	if (major >= 2 && major <= 4 && minor === 2) return cryptoApiCipher(table, table.length) === "other" ? "unknown" : "cryptoApiRc4"

	return "unknown"
}

const F_CRYPTOAPI = 0x04
const F_AES = 0x20
const ALG_RC4 = 0x6801
const ALG_AES_128 = 0x660e
const ALG_AES_256 = 0x6610
const ALG_SHA1 = 0x8004

// The cipher a CryptoAPI EncryptionHeader names ([MS-OFFCRYPTO] §2.3.2: Flags, SizeExtra, AlgID, AlgIDHash after
// the 12-byte prefix of version, flags and header size, within the first `end` bytes): RC4 with SHA-1, another cipher
// (AES), or a header too short or without fCryptoAPI to say. AlgID 0 is the default the flags name: AES with fAES,
// else RC4 (§2.3.2, §2.3.5.1); AlgIDHash 0 is SHA-1.
function cryptoApiCipher(table: Uint8Array, end: number): "rc4" | "other" | "malformed" {
	if (end < 12 || table.length < 12) return "malformed"

	const headerSize = le32(table, 8)

	if (headerSize < 32 || 12 + headerSize > Math.min(end, table.length)) return "malformed"

	const flags = le32(table, 12)

	if ((flags & F_CRYPTOAPI) === 0) return "malformed"

	const algId = le32(table, 12 + 8)
	const algIdHash = le32(table, 12 + 12)
	const cipher =
		algId === 0
			? (flags & F_AES) === 0
				? "rc4"
				: "aes"
			: algId === ALG_RC4
				? "rc4"
				: algId >= ALG_AES_128 && algId <= ALG_AES_256
					? "aes"
					: "other"

	return cipher === "rc4" && (algIdHash === ALG_SHA1 || algIdHash === 0) ? "rc4" : "other"
}
