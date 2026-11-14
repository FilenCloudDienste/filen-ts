import { BidiClass } from "../text/classes"
import { bidiClassTable } from "../text/unicode"
import { concat } from "./bytes"
import { PdfWriteError } from "./errors"
import { utf8 } from "./objects"

// The standard security handler, revision 6: AES-256 (ISO 32000-2 §7.6.4, Algorithms 2.A, 2.B, 8, 9 and 10;
// streams and strings per §7.6.3.3 with AESV3). The user and owner passwords are the source document's
// password, and every permission is granted (the password protects reading, as it did in the source).
//
// Only WebCrypto: SHA-256/384/512 and AES-CBC. AES-CBC without padding (Algorithm 2.B, UE, OE) is AES-CBC
// with PKCS#7 padding minus its last block, which depends only on the blocks before it; AES-ECB of one block
// (Perms) is AES-CBC with a zero IV.

interface CryptoKeyHandle {
	readonly type: string
}

interface SubtleLike {
	digest(algorithm: "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array): Promise<ArrayBuffer>
	importKey(
		format: "raw",
		keyData: Uint8Array,
		algorithm: "AES-CBC",
		extractable: false,
		usages: readonly "encrypt"[]
	): Promise<CryptoKeyHandle>
	encrypt(algorithm: { readonly name: "AES-CBC"; readonly iv: Uint8Array }, key: CryptoKeyHandle, data: Uint8Array): Promise<ArrayBuffer>
}

interface CryptoLike {
	readonly subtle: SubtleLike
	getRandomValues(array: Uint8Array): Uint8Array
}

function platform(): CryptoLike {
	const crypto: unknown = Reflect.get(globalThis, "crypto")
	const subtle: unknown = typeof crypto === "object" && crypto !== null ? Reflect.get(crypto, "subtle") : undefined

	if (typeof subtle !== "object" || subtle === null) throw new PdfWriteError("unsupported", "WebCrypto is not available")

	return crypto as CryptoLike
}

export type RandomBytes = (length: number) => Uint8Array

export function platformRandom(length: number): Uint8Array {
	return platform().getRandomValues(new Uint8Array(length))
}

const ZERO_IV = new Uint8Array(16)

async function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const subtle = platform().subtle
	const handle = await subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"])

	return new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, handle, data))
}

// AES-CBC without padding: `data` is a whole number of blocks.
async function aesCbcNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	return (await aesCbc(key, iv, data)).subarray(0, data.length)
}

async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await platform().subtle.digest(`SHA-${bits}`, data))
}

// Algorithm 2.B: the hash of a password with a salt (and, for the owner entries, the 48-byte U value).
export async function hash2B(password: Uint8Array, salt: Uint8Array, userKey: Uint8Array): Promise<Uint8Array> {
	let k = await sha(256, concat([password, salt, userKey]))
	let e: Uint8Array = new Uint8Array(0)

	for (let round = 0; round < 64 || (e[e.length - 1] ?? 0) > round - 32; round++) {
		const block = concat([password, k, userKey])
		const k1 = new Uint8Array(block.length * 64)

		for (let copy = 0; copy < 64; copy++) k1.set(block, copy * block.length)

		e = await aesCbcNoPad(k.subarray(0, 16), k.subarray(16, 32), k1)

		// The first 16 bytes as a big-endian number mod 3 equals their byte sum mod 3 (256 ≡ 1 mod 3).
		let sum = 0

		for (let index = 0; index < 16; index++) sum += e[index] ?? 0

		const remainder = sum % 3

		k = await sha(remainder === 0 ? 256 : remainder === 1 ? 384 : 512, e)
	}

	return k.slice(0, 32)
}

// §7.6.4.3.3: SASLprep (RFC 4013) then UTF-8, at most 127 bytes. Bidi classes come from the current Unicode
// data, not Unicode 3.2 as RFC 3454 says; they differ only for characters assigned since.
export function preparePassword(password: string): Uint8Array {
	const bytes = utf8(saslPrepPassword(password))

	if (bytes.length <= 127) return bytes

	// Truncate at 127 bytes, never inside a character.
	let end = 127

	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--

	return bytes.slice(0, end)
}

// SASLprep (RFC 4013) of a password, as a string (before UTF-8 and the 127-byte cut).
export function saslPrepPassword(password: string): string {
	let mapped = ""

	for (const char of password) {
		const cp = char.codePointAt(0) ?? 0

		if (mapsToNothing(cp)) continue

		mapped += nonAsciiSpace(cp) ? " " : char
	}

	let normalized: string

	try {
		normalized = mapped.normalize("NFKC")
	} catch {
		throw new PdfWriteError("unsupported", "Unicode normalization is not available")
	}

	const bidi = bidiClassTable()
	let rtl = false
	let ltr = false
	const chars = [...normalized]

	for (const char of chars) {
		const cp = char.codePointAt(0) ?? 0

		if (prohibited(cp))
			throw new PdfWriteError("password", "The password holds a character the PDF standard security handler prohibits")

		const type = bidi.get(cp)

		if (type === BidiClass.R || type === BidiClass.AL) rtl = true
		else if (type === BidiClass.L) ltr = true
	}

	if (rtl) {
		const first = bidi.get(chars[0]?.codePointAt(0) ?? 0)
		const last = bidi.get(chars[chars.length - 1]?.codePointAt(0) ?? 0)
		const isRtl = (type: number): boolean => type === BidiClass.R || type === BidiClass.AL

		if (ltr || !isRtl(first) || !isRtl(last))
			throw new PdfWriteError("password", "The password mixes text directions as SASLprep prohibits")
	}

	return normalized
}

// RFC 3454 table B.1.
function mapsToNothing(cp: number): boolean {
	return (
		cp === 0xad ||
		cp === 0x34f ||
		cp === 0x1806 ||
		(cp >= 0x180b && cp <= 0x180d) ||
		(cp >= 0x200c && cp <= 0x200d) ||
		cp === 0x2060 ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		cp === 0xfeff
	)
}

// RFC 3454 table C.1.2.
function nonAsciiSpace(cp: number): boolean {
	return cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200b) || cp === 0x202f || cp === 0x205f || cp === 0x3000
}

// RFC 4013 §2.3: tables C.1.2, C.2.1, C.2.2, C.3, C.4, C.5, C.6, C.7, C.8 and C.9.
function prohibited(cp: number): boolean {
	if (nonAsciiSpace(cp)) return true
	if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true
	if (cp === 0x6dd || cp === 0x70f || cp === 0x180e || (cp >= 0x200c && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e)) return true
	if ((cp >= 0x2060 && cp <= 0x2063) || (cp >= 0x206a && cp <= 0x206f) || cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffd)) return true
	if (cp >= 0x1d173 && cp <= 0x1d17a) return true
	if (cp === 0x340 || cp === 0x341) return true
	if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return true
	if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true
	if (cp >= 0xd800 && cp <= 0xdfff) return true
	if (cp >= 0x2ff0 && cp <= 0x2ffb) return true
	if (cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f)) return true

	return false
}

export interface SecurityHandler {
	// The /Encrypt dictionary entries (written unencrypted, outside object streams).
	readonly dictionary: {
		readonly O: Uint8Array
		readonly U: Uint8Array
		readonly OE: Uint8Array
		readonly UE: Uint8Array
		readonly Perms: Uint8Array
		readonly P: number
	}
	// Encrypts a string or stream: a random IV, then AES-256-CBC with PKCS#7 padding (§7.6.3.3, AESV3).
	encrypt(data: Uint8Array): Promise<Uint8Array>
}

// Every permission (bits 3-6 and 9-12), as a signed 32-bit value with the reserved high bits set (Table 22).
const ALL_PERMISSIONS = -4

// The standard security handler's state as plain data: the /Encrypt entries and the file key. Made where the password
// is (standardSecurityKey) and turned into a handler where the PDF is written (securityOfKey), so a writer can seal a
// document under a password it never holds. The file key opens this one PDF only.
export interface PdfSecurityKey {
	readonly dictionary: SecurityHandler["dictionary"]
	readonly fileKey: Uint8Array
}

// Algorithms 8, 9 and 10 for one password used as both user and owner password.
export async function standardSecurityKey(password: string, random: RandomBytes = platformRandom): Promise<PdfSecurityKey> {
	const secret = preparePassword(password)
	const fileKey = random(32)
	const userValidation = random(8)
	const userKeySalt = random(8)
	const U = concat([await hash2B(secret, userValidation, new Uint8Array(0)), userValidation, userKeySalt])
	const UE = await aesCbcNoPad(await hash2B(secret, userKeySalt, new Uint8Array(0)), ZERO_IV, fileKey)
	const ownerValidation = random(8)
	const ownerKeySalt = random(8)
	const O = concat([await hash2B(secret, ownerValidation, U), ownerValidation, ownerKeySalt])
	const OE = await aesCbcNoPad(await hash2B(secret, ownerKeySalt, U), ZERO_IV, fileKey)
	const permsBlock = new Uint8Array(16)
	const view = new DataView(permsBlock.buffer)

	view.setInt32(0, ALL_PERMISSIONS, true)
	view.setUint32(4, 0xffffffff, true)
	// EncryptMetadata true, then "adb", then 4 random bytes.
	permsBlock.set([0x54, 0x61, 0x64, 0x62], 8)
	permsBlock.set(random(4), 12)

	const Perms = await aesCbcNoPad(fileKey, ZERO_IV, permsBlock)

	secret.fill(0)

	return { dictionary: { O, U, OE, UE, Perms, P: ALL_PERMISSIONS }, fileKey }
}

// The handler of a key made by standardSecurityKey: strings and streams get a fresh IV each (`random`).
export function securityOfKey(key: PdfSecurityKey, random: RandomBytes = platformRandom): SecurityHandler {
	const fileKey = key.fileKey.slice()

	if (fileKey.length !== 32) throw new PdfWriteError("password", "The PDF security key is not an AES-256 key")

	return {
		dictionary: key.dictionary,
		encrypt: async data => {
			const iv = random(16)

			return concat([iv, await aesCbc(fileKey, iv, data)])
		}
	}
}

export async function standardSecurity(password: string, random: RandomBytes = platformRandom): Promise<SecurityHandler> {
	return securityOfKey(await standardSecurityKey(password, random), random)
}
