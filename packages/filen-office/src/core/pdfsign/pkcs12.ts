import * as asn1js from "asn1js"
import type * as Forge from "node-forge"
import {
	AlgorithmIdentifier,
	AuthenticatedSafe,
	CertBag,
	Certificate,
	ContentInfo,
	EncryptedContentInfo,
	EncryptedData,
	PFX,
	PKCS8ShroudedKeyBag,
	PrivateKeyInfo,
	RSAPrivateKey,
	SafeContents,
	getCrypto,
	type SafeBag
} from "pkijs"
import { certificateChain } from "./certificate"
import { derOf } from "./cms"
import { keyMatchesCertificate, schemeParams, type PdfSignatureScheme, type PdfSigningIdentity, type PdfSigningSubtle } from "./cmsBuild"
import { equalBytes } from "./source"
import { webCryptoSpki } from "./keyInfo"

// Reads the signing key and certificates out of a PKCS#12 (.p12/.pfx) container. Modern containers (PBES2: PBKDF2 +
// AES) decrypt with pkijs on WebCrypto; the legacy ones older exports still write (3DES or RC2 with the PKCS#12 key
// derivation) with node-forge's ciphers, which WebCrypto lacks. The password is tried as UTF-8 and as BMPString (UTF-16
// big-endian, PKCS#12 §B.1), the two encodings writers use. The key is imported non-extractable and the decrypted
// PKCS#8 bytes are zeroed (best effort: the parsers' own copies are garbage the caller's worker takes with it when it
// is terminated, which is the real wipe). The leaf certificate is the one carrying the key's localKeyId, else any
// whose public key matches; a test signature proves the match before the key is used.

export type PdfPkcs12Failure =
	// Not a PKCS#12 container, or one this reader cannot take apart.
	| "malformed"
	| "password"
	| "noKey"
	| "noCertificate"
	// A key type or curve WebCrypto cannot sign with here (Brainpool, Ed25519 in an older browser).
	| "algorithm"
	// An RSA key shorter than 2048 bits: its signature would be rejected as weak.
	| "weakKey"
	// No certificate in the container belongs to the key.
	| "keyMismatch"

export class PdfPkcs12Error extends Error {
	override readonly name = "PdfPkcs12Error"

	readonly reason: PdfPkcs12Failure

	constructor(reason: PdfPkcs12Failure) {
		super(reason)
		this.reason = reason
	}
}

// node-forge's PKCS#12 key derivation and its 3DES/RC2 ciphers: only the legacy containers need them.
export type PdfLegacyCiphers = Pick<typeof Forge, "pkcs12" | "cipher" | "rc2" | "util">

export interface ImportPkcs12Options {
	readonly subtle: PdfSigningSubtle
	readonly legacy?: PdfLegacyCiphers | null
}

const OIDS = {
	pbes2: "1.2.840.113549.1.5.13",
	data: "1.2.840.113549.1.7.1",
	encryptedData: "1.2.840.113549.1.7.6",
	keyBag: "1.2.840.113549.1.12.10.1.1",
	shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
	certBag: "1.2.840.113549.1.12.10.1.3",
	safeContentsBag: "1.2.840.113549.1.12.10.1.6",
	localKeyId: "1.2.840.113549.1.9.21",
	rsa: "1.2.840.113549.1.1.1",
	rsaPss: "1.2.840.113549.1.1.10",
	ec: "1.2.840.10045.2.1",
	ed25519: "1.3.101.112"
} as const

// PKCS#12 PBE (RFC 7292 appendix C): key length, cipher, effective RC2 bits.
const LEGACY_PBE = new Map<string, { readonly keyBytes: number; readonly cipher: "3DES" | "RC2"; readonly rc2Bits?: number }>([
	["1.2.840.113549.1.12.1.3", { keyBytes: 24, cipher: "3DES" }],
	["1.2.840.113549.1.12.1.4", { keyBytes: 16, cipher: "3DES" }],
	["1.2.840.113549.1.12.1.5", { keyBytes: 16, cipher: "RC2", rc2Bits: 128 }],
	["1.2.840.113549.1.12.1.6", { keyBytes: 5, cipher: "RC2", rc2Bits: 40 }]
])

const CURVES = new Map<string, "P-256" | "P-384" | "P-521">([
	["1.2.840.10045.3.1.7", "P-256"],
	["1.3.132.0.34", "P-384"],
	["1.3.132.0.35", "P-521"]
])
const CURVE_DIGESTS = { "P-256": "SHA-256", "P-384": "SHA-384", "P-521": "SHA-512" } as const
const MIN_RSA_BITS = 2048
// Bags and nesting a container may have: real ones hold a key and a few certificates.
const MAX_BAGS = 256
const MAX_DEPTH = 4

interface KeyEntry {
	readonly pkcs8: Uint8Array<ArrayBuffer>
	readonly localKeyId: Uint8Array | null
}

interface CertificateEntry {
	readonly certificate: Certificate
	readonly localKeyId: Uint8Array | null
}

function owned(view: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(view)
}

function binary(bytes: Uint8Array): string {
	let text = ""

	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))

	return text
}

function fromBinary(text: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(text.length)

	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff

	return out
}

// BMPString with its two-byte terminator: each UTF-16 code unit big-endian.
function bmpString(password: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(password.length * 2 + 2)

	for (let i = 0; i < password.length; i++) {
		const unit = password.charCodeAt(i)

		out[i * 2] = unit >> 8
		out[i * 2 + 1] = unit & 0xff
	}

	return out
}

function fail(reason: PdfPkcs12Failure): never {
	throw new PdfPkcs12Error(reason)
}

// The PBES2 password as UTF-8 (RFC 9579), then as BMPString (writers that reuse the PKCS#12 encoding).
function pbes2Passwords(password: string): Uint8Array<ArrayBuffer>[] {
	return [owned(new TextEncoder().encode(password)), bmpString(password)]
}

// The legacy PBE password as forge's KDF takes it (a string turned into BMPString code unit by code unit): the text
// itself, then its UTF-8 bytes one per unit (what writers that ignored the encoding produced).
function legacyPasswords(password: string): string[] {
	const utf8 = binary(new TextEncoder().encode(password))

	return utf8 === password ? [password] : [password, utf8]
}

function legacyDecrypt(
	legacy: PdfLegacyCiphers,
	algorithm: AlgorithmIdentifier,
	data: Uint8Array,
	password: string
): Uint8Array<ArrayBuffer> {
	const pbe = LEGACY_PBE.get(algorithm.algorithmId)
	const params: unknown = algorithm.algorithmParams

	if (pbe === undefined || !(params instanceof asn1js.Sequence)) fail("malformed")

	const [salt, iterations] = params.valueBlock.value

	if (!(salt instanceof asn1js.OctetString) || !(iterations instanceof asn1js.Integer)) fail("malformed")

	const count = iterations.valueBlock.valueDec

	if (!Number.isSafeInteger(count) || count < 1) fail("malformed")

	const saltBuffer = (): Forge.util.ByteBuffer => legacy.util.createBuffer(binary(salt.valueBlock.valueHexView), "raw")
	let key = legacy.pkcs12.generateKey(password, saltBuffer(), 1, count, pbe.keyBytes).getBytes()
	const iv = legacy.pkcs12.generateKey(password, saltBuffer(), 2, count, 8).getBytes()
	const input = legacy.util.createBuffer(binary(data), "raw")
	let output: string

	if (pbe.cipher === "3DES") {
		// Two-key 3DES is K1 K2 K1.
		if (key.length === 16) key += key.slice(0, 8)

		const cipher = legacy.cipher.createDecipher("3DES-CBC", key)

		cipher.start({ iv })
		cipher.update(input)

		if (!cipher.finish()) throw new Error("padding")

		output = cipher.output.getBytes()
	} else {
		const cipher = legacy.rc2.createDecryptionCipher(key, pbe.rc2Bits)

		cipher.start(iv)
		cipher.update(input)

		if (!cipher.finish()) throw new Error("padding")

		output = cipher.output.getBytes()
	}

	return fromBinary(output)
}

// Decrypts with each encoding of the password in turn; a wrong one fails on the padding or on parsing what came out.
async function decryptContent<T>(
	algorithm: AlgorithmIdentifier,
	data: asn1js.OctetString,
	password: string,
	legacy: PdfLegacyCiphers | null,
	parse: (bytes: Uint8Array<ArrayBuffer>) => T
): Promise<T> {
	if (algorithm.algorithmId === OIDS.pbes2) {
		const engine = getCrypto(true)
		const info = new EncryptedContentInfo({ contentType: OIDS.data, contentEncryptionAlgorithm: algorithm, encryptedContent: data })

		for (const encoded of pbes2Passwords(password)) {
			let plain: Uint8Array<ArrayBuffer>

			try {
				plain = new Uint8Array(await engine.decryptEncryptedContentInfo({ password: encoded.buffer, encryptedContentInfo: info }))
			} catch {
				continue
			}

			try {
				return parse(plain)
			} catch {
				plain.fill(0)
			}
		}

		return fail("password")
	}

	if (!LEGACY_PBE.has(algorithm.algorithmId)) return fail("malformed")
	if (legacy === null) return fail("algorithm")

	const encrypted = encryptedBytes(data)

	for (const candidate of legacyPasswords(password)) {
		let plain: Uint8Array<ArrayBuffer>

		try {
			plain = legacyDecrypt(legacy, algorithm, encrypted, candidate)
		} catch (error) {
			if (error instanceof PdfPkcs12Error) throw error

			continue
		}

		try {
			return parse(plain)
		} catch {
			plain.fill(0)
		}
	}

	return fail("password")
}

// The bytes of an OCTET STRING, joining a constructed one's parts.
function encryptedBytes(value: asn1js.OctetString): Uint8Array {
	if (!value.valueBlock.isConstructed) return value.valueBlock.valueHexView

	return new Uint8Array(value.valueBlock.value.flatMap(part => (part instanceof asn1js.OctetString ? [...encryptedBytes(part)] : [])))
}

function localKeyId(bag: SafeBag): Uint8Array | null {
	const attribute = bag.bagAttributes?.find(item => item.type === OIDS.localKeyId)
	const value: unknown = attribute?.values[0]

	return value instanceof asn1js.OctetString ? value.valueBlock.valueHexView : null
}

// The PKCS#8 bytes when they parse as a PrivateKeyInfo: a wrong password's output does not.
function checkedPkcs8(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	PrivateKeyInfo.fromBER(bytes)

	return bytes
}

async function collectBags(
	bags: readonly SafeBag[],
	password: string,
	legacy: PdfLegacyCiphers | null,
	keys: KeyEntry[],
	certificates: CertificateEntry[],
	depth: number
): Promise<void> {
	if (depth > MAX_DEPTH || bags.length + keys.length + certificates.length > MAX_BAGS) fail("malformed")

	for (const bag of bags) {
		const value: unknown = bag.bagValue

		if (bag.bagId === OIDS.shroudedKeyBag && value instanceof PKCS8ShroudedKeyBag) {
			keys.push({
				pkcs8: await decryptContent(value.encryptionAlgorithm, value.encryptedData, password, legacy, checkedPkcs8),
				localKeyId: localKeyId(bag)
			})
		} else if (bag.bagId === OIDS.keyBag && value instanceof PrivateKeyInfo) {
			keys.push({ pkcs8: owned(derOf(value.toSchema())), localKeyId: localKeyId(bag) })
		} else if (bag.bagId === OIDS.certBag && value instanceof CertBag && value.parsedValue instanceof Certificate) {
			certificates.push({ certificate: value.parsedValue, localKeyId: localKeyId(bag) })
		} else if (bag.bagId === OIDS.safeContentsBag && value instanceof SafeContents) {
			await collectBags(value.safeBags, password, legacy, keys, certificates, depth + 1)
		}
	}
}

async function readContainer(bytes: Uint8Array, password: string, legacy: PdfLegacyCiphers | null) {
	let pfx: PFX

	try {
		pfx = PFX.fromBER(owned(bytes))
	} catch {
		return fail("malformed")
	}

	try {
		// The MAC proves the password before anything is decrypted (pkijs takes it as UTF-8 and derives the BMPString).
		await pfx.parseInternalValues({
			password: owned(new TextEncoder().encode(password)).buffer,
			checkIntegrity: pfx.macData !== undefined
		})
	} catch (error) {
		return fail(error instanceof Error && /integrity/i.test(error.message) ? "password" : "malformed")
	}

	const safe: unknown = pfx.parsedValue?.authenticatedSafe

	if (!(safe instanceof AuthenticatedSafe)) return fail("malformed")

	const keys: KeyEntry[] = []
	const certificates: CertificateEntry[] = []

	for (const content of safe.safeContents) {
		let contents: SafeContents

		if (content.contentType === OIDS.data && content.content instanceof asn1js.OctetString) {
			contents = parseSafeContents(owned(encryptedBytes(content.content)))
		} else if (content.contentType === OIDS.encryptedData) {
			const encrypted = encryptedDataOf(content)
			const data = encrypted.encryptedContentInfo.encryptedContent

			if (data === undefined) return fail("malformed")

			contents = await decryptContent(
				encrypted.encryptedContentInfo.contentEncryptionAlgorithm,
				data,
				password,
				legacy,
				parseSafeContents
			)
		} else {
			// Public-key privacy (EnvelopedData) needs a key the user does not have here.
			return fail("malformed")
		}

		await collectBags(contents.safeBags, password, legacy, keys, certificates, 0)
	}

	return { keys, certificates }
}

function parseSafeContents(bytes: Uint8Array<ArrayBuffer>): SafeContents {
	return SafeContents.fromBER(bytes)
}

function encryptedDataOf(content: ContentInfo): EncryptedData {
	try {
		return new EncryptedData({ schema: content.content })
	} catch {
		return fail("malformed")
	}
}

// How the key signs, from its PKCS#8 algorithm; PKCS#8 with an RSA-PSS identifier is rewritten as plain RSA, which is
// the only RSA form WebCrypto imports (the key material is the same).
function schemeOf(pkcs8: Uint8Array<ArrayBuffer>): { readonly scheme: PdfSignatureScheme; readonly importable: Uint8Array<ArrayBuffer> } {
	let info: PrivateKeyInfo

	try {
		info = PrivateKeyInfo.fromBER(pkcs8)
	} catch {
		return fail("malformed")
	}

	const algorithm = info.privateKeyAlgorithm.algorithmId

	if (algorithm === OIDS.rsa || algorithm === OIDS.rsaPss) {
		let bits: number

		try {
			bits = modulusBits(RSAPrivateKey.fromBER(owned(info.privateKey.valueBlock.valueHexView)).modulus.valueBlock.valueHexView)
		} catch {
			return fail("malformed")
		}

		if (bits < MIN_RSA_BITS) fail("weakKey")
		if (algorithm === OIDS.rsa) return { scheme: { name: "RSASSA-PKCS1-v1_5", digest: "SHA-256", bits }, importable: pkcs8 }

		info.privateKeyAlgorithm = new AlgorithmIdentifier({ algorithmId: OIDS.rsa, algorithmParams: new asn1js.Null() })

		return { scheme: { name: "RSA-PSS", digest: "SHA-256", bits }, importable: owned(derOf(info.toSchema())) }
	}

	if (algorithm === OIDS.ec) {
		const params: unknown = info.privateKeyAlgorithm.algorithmParams
		const curve = params instanceof asn1js.ObjectIdentifier ? CURVES.get(params.valueBlock.toString()) : undefined

		if (curve === undefined) return fail("algorithm")

		return { scheme: { name: "ECDSA", digest: CURVE_DIGESTS[curve], curve }, importable: pkcs8 }
	}

	if (algorithm === OIDS.ed25519) return { scheme: { name: "Ed25519", digest: "SHA-512" }, importable: pkcs8 }

	return fail("algorithm")
}

function modulusBits(modulus: Uint8Array): number {
	let at = 0

	while (at < modulus.length && modulus[at] === 0) at++

	const top = modulus[at]

	return top === undefined ? 0 : (modulus.length - at - 1) * 8 + (32 - Math.clz32(top))
}

// The certificates to try for a key: those carrying its localKeyId first.
function candidates(key: KeyEntry, certificates: readonly CertificateEntry[]): Certificate[] {
	const id = key.localKeyId
	const matching = id === null ? [] : certificates.filter(entry => entry.localKeyId !== null && equalBytes(entry.localKeyId, id))

	return [...matching, ...certificates.filter(entry => !matching.includes(entry))].map(entry => entry.certificate)
}

export async function importPkcs12(bytes: Uint8Array, password: string, options: ImportPkcs12Options): Promise<PdfSigningIdentity> {
	const { keys, certificates } = await readContainer(bytes, password, options.legacy ?? null)

	try {
		if (keys.length === 0) fail("noKey")
		if (certificates.length === 0) fail("noCertificate")

		let failure: PdfPkcs12Failure = "keyMismatch"

		for (const key of keys) {
			let found: { readonly scheme: PdfSignatureScheme; readonly importable: Uint8Array<ArrayBuffer> }

			try {
				found = schemeOf(key.pkcs8)
			} catch (error) {
				if (!(error instanceof PdfPkcs12Error)) throw error

				failure = error.reason
				continue
			}

			let privateKey: unknown

			try {
				privateKey = await options.subtle.importKey("pkcs8", found.importable, schemeParams(found.scheme).import, false, ["sign"])
			} catch {
				failure = "algorithm"
				continue
			} finally {
				found.importable.fill(0)
			}

			for (const certificate of candidates(key, certificates)) {
				if (await keyMatchesCertificate(privateKey, found.scheme, certificate, options.subtle, webCryptoSpki)) {
					return {
						key: privateKey,
						scheme: found.scheme,
						chain: certificateChain(
							certificate,
							certificates.map(entry => entry.certificate)
						)
					}
				}
			}
		}

		return fail(failure)
	} finally {
		for (const key of keys) key.pkcs8.fill(0)
	}
}
