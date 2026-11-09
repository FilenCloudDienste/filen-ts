import { Ns } from "../model/namespaces"
import { partReader } from "../model/reader"
import type { DocxSettings } from "../model/settings"

// The password hash of w:writeProtection (ECMA-376 Part 1 §17.15.1.93, "password to modify") and of
// w:documentProtection (§17.15.1.29), read for verifying a password, and the attributes a new one is written
// with; nothing here hashes (that is the platform's: dom/protection.ts). Word writes the transitional attributes (w:cryptAlgorithmSid,
// w:cryptSpinCount, w:hash, w:salt; ECMA-376 1st ed. Part 4 §2.15.1.28, §2.15.1.94), or the ISO ones
// (w:algorithmName, w:hashValue, w:saltValue, w:spinCount) when UseIsoPasswordVerifier is set (MS-OI29500
// §2.1.426 b). Both hash alike ([MS-OFFCRYPTO] §2.4.2.4): H0 = H(salt + input), then Hn = H(Hn-1 + LE32(i))
// for i < spinCount, the first hash not counted (MS-OI29500 documentProtection notes a, b, e). The input is
// the password as UTF-16LE, except for documentProtection's transitional hash: there it is Word's legacy
// 32-bit verifier of the password ([MS-OFFCRYPTO] §2.3.7.4) as the upper-case hex of its little-endian bytes
// (Part 4 §2.15.1.28). Word's own writeProtection hash takes the password as it is (a Word 2016 sample).

export type ProtectionHashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

// Word supports spin counts up to 10,000,000 (MS-OI29500 documentProtection note d); salts are at most
// 65,536 bytes ([MS-OFFCRYPTO] §2.4.2.4).
export const MAX_PROTECTION_SPIN_COUNT = 10_000_000
export const MAX_PROTECTION_SALT_BYTES = 65_536

export interface ProtectionHash {
	readonly algorithm: ProtectionHashName
	// base64Binary as written.
	readonly hash: string
	readonly salt: string
	readonly spinCount: number
	// What is hashed: the password ("plain"), its legacy verifier ("legacy"), or either, tried in that order
	// (documentProtection's ISO attributes, whose pre-processing MS-OI29500 leaves to the parent element).
	readonly input: "plain" | "legacy" | "either"
}

// The hash a protection element carries: undefined without one, "unsupported" for one no platform digest
// computes (MD2, MD4, MD5, RIPEMD, WHIRLPOOL, an extension algorithm) or with out-of-bounds parameters.
export type ProtectionHashRead = ProtectionHash | "unsupported" | undefined

// A w:documentProtection password hash to write, as Word writes one: the transitional attributes, the password's
// legacy verifier hashed (dom/protection.ts hashDocumentProtectionPassword). base64Binary.
export interface DocumentProtectionHash {
	readonly algorithm: ProtectionHashName
	readonly hash: string
	readonly salt: string
	readonly spinCount: number
}

// The cryptAlgorithmSid values (Part 4 §2.15.1.28) with a platform digest; the rest are unsupported.
const ALGORITHM_SIDS: ReadonlyMap<string, ProtectionHashName> = new Map([
	["4", "SHA-1"],
	["12", "SHA-256"],
	["13", "SHA-384"],
	["14", "SHA-512"]
])

const SIDS: Readonly<Record<ProtectionHashName, string>> = { "SHA-1": "4", "SHA-256": "12", "SHA-384": "13", "SHA-512": "14" }

// The transitional attributes of `hash`, in schema order (AG_TransitionalPassword): Word writes rsaAES with SHA-2
// and rsaFull with SHA-1.
export function documentProtectionHashAttributes(hash: DocumentProtectionHash): readonly (readonly [string, string])[] {
	return [
		["cryptProviderType", hash.algorithm === "SHA-1" ? "rsaFull" : "rsaAES"],
		["cryptAlgorithmClass", "hash"],
		["cryptAlgorithmType", "typeAny"],
		["cryptAlgorithmSid", SIDS[hash.algorithm]],
		["cryptSpinCount", String(hash.spinCount)],
		["hash", hash.hash],
		["salt", hash.salt]
	]
}

// A written hash as one to check a password against.
export function documentProtectionHashRead(hash: DocumentProtectionHash): ProtectionHash {
	return { algorithm: hash.algorithm, hash: hash.hash, salt: hash.salt, spinCount: hash.spinCount, input: "legacy" }
}

const ALGORITHM_NAMES: ReadonlyMap<string, ProtectionHashName> = new Map([
	["SHA-1", "SHA-1"],
	["SHA-256", "SHA-256"],
	["SHA-384", "SHA-384"],
	["SHA-512", "SHA-512"]
])

function spinCount(text: string | undefined): number | undefined {
	if (text === undefined) return 0
	if (!/^\s*\d{1,9}\s*$/.test(text)) return undefined

	const value = Number(text)

	return value <= MAX_PROTECTION_SPIN_COUNT ? value : undefined
}

export function readProtectionHash(settings: DocxSettings, element: "writeProtection" | "documentProtection"): ProtectionHashRead {
	const document = settings.document

	if (document === undefined) return undefined

	const reader = partReader(document)
	const node = reader.child(document.documentElement(), Ns.W, element)

	if (node < 0) return undefined

	const attr = (name: string): string | undefined => reader.attr(node, Ns.W, name)
	const legacy = attr("hash")

	// Word ignores algorithmName, hashValue, saltValue and spinCount next to the others (MS-OI29500 §2.1.1775).
	if (legacy !== undefined) {
		const algorithm = ALGORITHM_SIDS.get((attr("cryptAlgorithmSid") ?? "").trim())
		const spins = spinCount(attr("cryptSpinCount"))
		const extension = attr("algIdExt")

		if (
			algorithm === undefined ||
			spins === undefined ||
			(attr("cryptAlgorithmClass") ?? "hash") !== "hash" ||
			(attr("cryptAlgorithmType") ?? "typeAny") !== "typeAny" ||
			(extension !== undefined && !/^0*$/.test(extension.trim()))
		) {
			return "unsupported"
		}

		return {
			algorithm,
			hash: legacy,
			salt: attr("salt") ?? "",
			spinCount: spins,
			input: element === "writeProtection" ? "plain" : "legacy"
		}
	}

	const value = attr("hashValue")

	if (value === undefined) return undefined

	const algorithm = ALGORITHM_NAMES.get((attr("algorithmName") ?? "").trim().toUpperCase())
	const spins = spinCount(attr("spinCount"))

	if (algorithm === undefined || spins === undefined) return "unsupported"

	return {
		algorithm,
		hash: value,
		salt: attr("saltValue") ?? "",
		spinCount: spins,
		input: element === "writeProtection" ? "plain" : "either"
	}
}

// [MS-OFFCRYPTO] §2.3.7.2.
const INITIAL_CODE = [
	0xe1f0, 0x1d0f, 0xcc9c, 0x84c0, 0x110c, 0x0e10, 0xf1ce, 0x313e, 0x1872, 0xe139, 0xd40f, 0x84f9, 0x280c, 0xa96a, 0x4ec3
]
const XOR_MATRIX = [
	0xaefc, 0x4dd9, 0x9bb2, 0x2745, 0x4e8a, 0x9d14, 0x2a09, 0x7b61, 0xf6c2, 0xfda5, 0xeb6b, 0xc6f7, 0x9dcf, 0x2bbf, 0x4563, 0x8ac6, 0x05ad,
	0x0b5a, 0x16b4, 0x2d68, 0x5ad0, 0x0375, 0x06ea, 0x0dd4, 0x1ba8, 0x3750, 0x6ea0, 0xdd40, 0xd849, 0xa0b3, 0x5147, 0xa28e, 0x553d, 0xaa7a,
	0x44d5, 0x6f45, 0xde8a, 0xad35, 0x4a4b, 0x9496, 0x390d, 0x721a, 0xeb23, 0xc667, 0x9cef, 0x29ff, 0x53fe, 0xa7fc, 0x5fd9, 0x47d3, 0x8fa6,
	0x0f6d, 0x1eda, 0x3db4, 0x7b68, 0xf6d0, 0xb861, 0x60e3, 0xc1c6, 0x93ad, 0x377b, 0x6ef6, 0xddec, 0x45a0, 0x8b40, 0x06a1, 0x0d42, 0x1a84,
	0x3508, 0x6a10, 0xaa51, 0x4483, 0x8906, 0x022d, 0x045a, 0x08b4, 0x1168, 0x76b4, 0xed68, 0xcaf1, 0x85c3, 0x1ba7, 0x374e, 0x6e9c, 0x3730,
	0x6e60, 0xdcc0, 0xa9a1, 0x4363, 0x86c6, 0x1dad, 0x3331, 0x6662, 0xccc4, 0x89a9, 0x0373, 0x06e6, 0x0dcc, 0x1021, 0x2042, 0x4084, 0x8108,
	0x1231, 0x2462, 0x48c4
]
const MAX_LEGACY_LENGTH = 15

// Windows-1252's characters in 0x80..0x9F; 0x00..0x7F and 0xA0..0xFF map to themselves.
const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
	[0x20ac, 0x80],
	[0x201a, 0x82],
	[0x0192, 0x83],
	[0x201e, 0x84],
	[0x2026, 0x85],
	[0x2020, 0x86],
	[0x2021, 0x87],
	[0x02c6, 0x88],
	[0x2030, 0x89],
	[0x0160, 0x8a],
	[0x2039, 0x8b],
	[0x0152, 0x8c],
	[0x017d, 0x8e],
	[0x2018, 0x91],
	[0x2019, 0x92],
	[0x201c, 0x93],
	[0x201d, 0x94],
	[0x2022, 0x95],
	[0x2013, 0x96],
	[0x2014, 0x97],
	[0x02dc, 0x98],
	[0x2122, 0x99],
	[0x0161, 0x9a],
	[0x203a, 0x9b],
	[0x0153, 0x9c],
	[0x017e, 0x9e],
	[0x0178, 0x9f]
])

// The single-byte forms of a password §2.3.7.4 says to try when reading: each UTF-16 unit's low byte, or its
// high byte when the low one is 0 (what Word writes); and the ANSI code page's form, taken as Windows-1252
// (the user's LCID is not known here), when every character has one and it differs. Truncated to 15.
export function legacyPasswordBytes(password: string): Uint8Array[] {
	const length = Math.min(password.length, MAX_LEGACY_LENGTH)
	const written = new Uint8Array(length)
	let ansi: Uint8Array | undefined = new Uint8Array(length)
	let differs = false

	for (let k = 0; k < length; k++) {
		const unit = password.charCodeAt(k)
		const low = unit & 0xff

		written[k] = low !== 0 ? low : unit >> 8

		if (ansi === undefined) continue

		const code = unit < 0x80 || (unit >= 0xa0 && unit <= 0xff) ? unit : CP1252_HIGH.get(unit)

		if (code === undefined) ansi = undefined
		else {
			ansi[k] = code
			differs ||= code !== written[k]
		}
	}

	return ansi !== undefined && differs ? [written, ansi] : [written]
}

// CreatePasswordVerifier_Method2 ([MS-OFFCRYPTO] §2.3.7.4): CreateXorKey_Method1 (§2.3.7.2) in the high word,
// CreatePasswordVerifier_Method1 (§2.3.7.1) in the low one. 0 for an empty password.
export function legacyPasswordVerifier(password: Uint8Array): number {
	const length = Math.min(password.length, MAX_LEGACY_LENGTH)

	if (length === 0) return 0

	let key = INITIAL_CODE[length - 1] ?? 0
	let element = 0x68

	for (let k = length - 1; k >= 0; k--) {
		let char = password[k] ?? 0

		for (let bit = 0; bit < 7; bit++) {
			if ((char & 0x40) !== 0) key ^= XOR_MATRIX[element] ?? 0

			char = (char << 1) & 0xff
			element--
		}
	}

	let verifier = 0

	for (let k = length; k >= 0; k--) {
		const byte = k === 0 ? length : (password[k - 1] ?? 0)

		verifier = ((((verifier & 0x4000) === 0 ? 0 : 1) | ((verifier << 1) & 0x7fff)) ^ byte) & 0xffff
	}

	return ((key << 16) | (verifier ^ 0xce4b)) >>> 0
}

const HEX = "0123456789ABCDEF"

// The verifier's little-endian bytes as upper-case hex: "Example" → 0x64CEED7E → "7EEDCE64".
export function legacyVerifierText(verifier: number): string {
	let text = ""

	for (let shift = 0; shift < 32; shift += 8) {
		const byte = (verifier >>> shift) & 0xff

		text += (HEX[byte >> 4] ?? "") + (HEX[byte & 15] ?? "")
	}

	return text
}

// The texts whose UTF-16LE code units are hashed for `password` (H0 = H(salt + input)), in the order to try
// them.
export function protectionHashInputs(hash: ProtectionHash, password: string): string[] {
	const inputs: string[] = []

	if (hash.input !== "legacy") inputs.push(password)

	if (hash.input !== "plain") {
		for (const bytes of legacyPasswordBytes(password)) {
			inputs.push(legacyVerifierText(legacyPasswordVerifier(bytes)))
			bytes.fill(0)
		}
	}

	return inputs
}
