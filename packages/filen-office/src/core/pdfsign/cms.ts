import * as asn1js from "asn1js"
import { Certificate, ContentInfo, IssuerAndSerialNumber, RSAPublicKey, RSASSAPSSParams, SignedData, TSTInfo, type SignerInfo } from "pkijs"
import { RSA_ENCRYPTION_OID as RSA_KEY, RSA_PSS_OID as RSA_PSS, webCryptoSpki } from "./keyInfo"
import { digestBytes, equalBytes, type PdfDigestFactory } from "./source"
import type { PdfDigestName, PdfSignatureInvalidReason } from "./types"

// CMS SignedData of a PDF signature (PAdES / PKCS#7 detached) or timestamp token, parsed with pkijs and checked with
// WebCrypto. Exactly one signer; the signed attributes' message digest must equal the digest of what is signed; the
// signature must verify with the signer certificate's key. Weak algorithms (SHA-1, MD5, RSA under 2048 bits) fail.

// The WebCrypto calls made, typed structurally (no DOM types in the core). Methods, so a runtime's SubtleCrypto
// with its overloads is accepted.
export interface PdfSubtle {
	importKey(
		format: "spki",
		keyData: Uint8Array<ArrayBuffer>,
		algorithm: PdfAlgorithm,
		extractable: boolean,
		keyUsages: "verify"[]
	): Promise<unknown>
	verify(algorithm: PdfAlgorithm, key: unknown, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean>
}

// The WebCrypto algorithm parameters used: RSA (PKCS#1 v1.5, PSS), ECDSA and Ed25519.
export interface PdfAlgorithm {
	readonly name: string
	readonly hash?: string
	readonly namedCurve?: string
	readonly saltLength?: number
}

export interface PdfCryptoDeps {
	readonly subtle: PdfSubtle
	readonly createDigest: PdfDigestFactory
}

export const OID = {
	data: "1.2.840.113549.1.7.1",
	signedData: "1.2.840.113549.1.7.2",
	tstInfo: "1.2.840.113549.1.9.16.1.4",
	contentType: "1.2.840.113549.1.9.3",
	messageDigest: "1.2.840.113549.1.9.4",
	signingTime: "1.2.840.113549.1.9.5",
	timeStampToken: "1.2.840.113549.1.9.16.2.14",
	subjectKeyIdentifier: "2.5.29.14"
} as const

const DIGESTS = new Map<string, PdfDigestName | "weak">([
	["2.16.840.1.101.3.4.2.1", "SHA-256"],
	["2.16.840.1.101.3.4.2.2", "SHA-384"],
	["2.16.840.1.101.3.4.2.3", "SHA-512"],
	["1.3.14.3.2.26", "weak"],
	["1.2.840.113549.2.5", "weak"]
])

const RSA_SIGNATURES = new Map<string, PdfDigestName | "weak" | null>([
	["1.2.840.113549.1.1.1", null],
	["1.2.840.113549.1.1.11", "SHA-256"],
	["1.2.840.113549.1.1.12", "SHA-384"],
	["1.2.840.113549.1.1.13", "SHA-512"],
	["1.2.840.113549.1.1.5", "weak"],
	["1.2.840.113549.1.1.4", "weak"]
])

const ECDSA_SIGNATURES = new Map<string, PdfDigestName | "weak" | null>([
	["1.2.840.10045.2.1", null],
	["1.2.840.10045.4.3.2", "SHA-256"],
	["1.2.840.10045.4.3.3", "SHA-384"],
	["1.2.840.10045.4.3.4", "SHA-512"],
	["1.2.840.10045.4.1", "weak"]
])

const CURVES = new Map<string, { readonly name: string; readonly size: number }>([
	["1.2.840.10045.3.1.7", { name: "P-256", size: 32 }],
	["1.3.132.0.34", { name: "P-384", size: 48 }],
	["1.3.132.0.35", { name: "P-521", size: 66 }]
])

const EC_KEY = "1.2.840.10045.2.1"
const ED25519 = "1.3.101.112"
const MGF1 = "1.2.840.113549.1.1.8"
const MIN_RSA_BITS = 2048

export interface ParsedCms {
	readonly signedData: SignedData
	readonly signer: SignerInfo
	readonly certificates: readonly Certificate[]
	readonly signerCertificate: Certificate | null
	// The signer's digest algorithm (null: unknown).
	readonly digest: PdfDigestName | "weak" | null
	readonly contentType: string
	// The embedded content (a timestamp token's TSTInfo); null when detached.
	readonly content: Uint8Array | null
}

export type CmsFailure =
	| { readonly ok: false; readonly state: "invalid"; readonly reason: PdfSignatureInvalidReason }
	| { readonly ok: false; readonly state: "unverifiable" }

export type CmsParseResult = { readonly ok: true; readonly cms: ParsedCms } | CmsFailure

const invalid = (reason: PdfSignatureInvalidReason): CmsFailure => ({ ok: false, state: "invalid", reason })

function bytesOf(view: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(view)
}

function octets(value: asn1js.OctetString): Uint8Array {
	if (!value.valueBlock.isConstructed) return value.valueBlock.valueHexView

	const parts: Uint8Array[] = []

	for (const part of value.valueBlock.value) if (part instanceof asn1js.OctetString) parts.push(octets(part))

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

export function parseCms(der: Uint8Array): CmsParseResult {
	let signedData: SignedData

	try {
		const info = ContentInfo.fromBER(bytesOf(der))

		if (info.contentType !== OID.signedData) return invalid("malformedSignature")

		signedData = new SignedData({ schema: info.content })
	} catch {
		return invalid("malformedSignature")
	}

	if (signedData.signerInfos.length !== 1) return invalid("signerCount")

	const signer = signedData.signerInfos[0]

	if (signer === undefined) return invalid("signerCount")

	const certificates = (signedData.certificates ?? []).filter((item): item is Certificate => item instanceof Certificate)
	const eContent = signedData.encapContentInfo.eContent

	return {
		ok: true,
		cms: {
			signedData,
			signer,
			certificates,
			signerCertificate: findSigner(signer, certificates),
			digest: DIGESTS.get(signer.digestAlgorithm.algorithmId) ?? null,
			contentType: signedData.encapContentInfo.eContentType,
			content: eContent === undefined ? null : octets(eContent)
		}
	}
}

function findSigner(signer: SignerInfo, certificates: readonly Certificate[]): Certificate | null {
	const sid: unknown = signer.sid

	if (sid instanceof IssuerAndSerialNumber) {
		const issuer = derOf(sid.issuer.toSchema())
		const serial = sid.serialNumber.valueBlock.valueHexView

		return (
			certificates.find(
				cert => equalBytes(derOf(cert.issuer.toSchema()), issuer) && equalBytes(cert.serialNumber.valueBlock.valueHexView, serial)
			) ?? null
		)
	}

	if (sid instanceof asn1js.BaseBlock) {
		const keyId = sid.valueBlock instanceof asn1js.ValueBlock && "valueHexView" in sid.valueBlock ? sid.valueBlock.valueHexView : null

		if (!(keyId instanceof Uint8Array)) return null

		return (
			certificates.find(cert => {
				const extension = cert.extensions?.find(item => item.extnID === OID.subjectKeyIdentifier)
				const value = extension?.parsedValue

				return value instanceof asn1js.OctetString && equalBytes(value.valueBlock.valueHexView, keyId)
			}) ?? null
		)
	}

	return null
}

export function derOf(schema: asn1js.AsnType): Uint8Array {
	return new Uint8Array(schema.toBER(false))
}

function attribute(signer: SignerInfo, type: string): asn1js.AsnType | null {
	const found = signer.signedAttrs?.attributes.filter(item => item.type === type) ?? []

	// Exactly one value of exactly one attribute: a duplicate is a second reading of the same signature.
	if (found.length !== 1 || found[0]?.values.length !== 1) return null

	const value: unknown = found[0].values[0]

	return value instanceof asn1js.BaseBlock ? value : null
}

// The signing-time attribute (CAdES leaves it out when the PDF's /M gives the claimed time).
export function signingTime(signer: SignerInfo): number | null {
	const value = attribute(signer, OID.signingTime)

	if (value instanceof asn1js.UTCTime || value instanceof asn1js.GeneralizedTime) return value.toDate().getTime()

	return null
}

export interface CmsVerified {
	readonly ok: true
	readonly algorithm: string
}

interface ResolvedAlgorithm {
	readonly importParams: PdfAlgorithm
	readonly verifyParams: PdfAlgorithm
	readonly label: string
	readonly ecSize: number | null
}

// Checks the signer against `expected`, the digest of what it signs (the file's ranges, or the embedded content).
export async function verifyCms(cms: ParsedCms, expected: Uint8Array, deps: PdfCryptoDeps): Promise<CmsVerified | CmsFailure> {
	const { signer } = cms

	if (cms.digest === "weak") return invalid("weakDigest")
	if (cms.digest === null) return { ok: false, state: "unverifiable" }

	// Without signed attributes the signature is over the content itself, which WebCrypto would have to read whole.
	if (signer.signedAttrs === undefined) return { ok: false, state: "unverifiable" }

	const contentType = attribute(signer, OID.contentType)

	if (!(contentType instanceof asn1js.ObjectIdentifier) || contentType.valueBlock.toString() !== cms.contentType)
		return invalid("malformedSignature")

	const messageDigest = attribute(signer, OID.messageDigest)

	if (!(messageDigest instanceof asn1js.OctetString)) return invalid("malformedSignature")
	if (!equalBytes(octets(messageDigest), expected)) return invalid("digestMismatch")

	const certificate = cms.signerCertificate

	if (certificate === null) return invalid("certificateMissing")

	const resolved = resolveAlgorithm(signer, certificate, cms.digest)

	if ("ok" in resolved) return resolved

	// The DER of the SET OF attributes: the [0] IMPLICIT tag replaced by SET, as signed.
	const signedAttrs = new Uint8Array(signer.signedAttrs.encodedValue)

	signedAttrs[0] = 0x31

	let signature: Uint8Array<ArrayBuffer> = bytesOf(signer.signature.valueBlock.valueHexView)

	if (resolved.ecSize !== null) {
		const raw = ecdsaRaw(signature, resolved.ecSize)

		if (raw === null) return invalid("signatureMismatch")

		signature = raw
	}

	let key: unknown

	try {
		key = await deps.subtle.importKey("spki", bytesOf(webCryptoSpki(certificate)), resolved.importParams, false, ["verify"])
	} catch {
		return { ok: false, state: "unverifiable" }
	}

	let valid: boolean

	try {
		valid = await deps.subtle.verify(resolved.verifyParams, key, signature, signedAttrs)
	} catch {
		return { ok: false, state: "unverifiable" }
	}

	return valid ? { ok: true, algorithm: resolved.label } : invalid("signatureMismatch")
}

function resolveAlgorithm(signer: SignerInfo, certificate: Certificate, digest: PdfDigestName): ResolvedAlgorithm | CmsFailure {
	const signatureId = signer.signatureAlgorithm.algorithmId
	const keyInfo = certificate.subjectPublicKeyInfo
	const keyId = keyInfo.algorithm.algorithmId

	// A key restricted to RSA-PSS signs only with RSA-PSS.
	if (keyId === RSA_KEY || (keyId === RSA_PSS && signatureId === RSA_PSS)) {
		const bits = rsaBits(keyInfo.subjectPublicKey.valueBlock.valueHexView)

		if (bits === null) return invalid("malformedSignature")
		if (bits < MIN_RSA_BITS) return invalid("weakKey")

		if (signatureId === RSA_PSS) return resolvePss(signer, bits)

		const hash = RSA_SIGNATURES.get(signatureId)

		if (hash === "weak") return invalid("weakDigest")
		if (hash === undefined) return { ok: false, state: "unverifiable" }

		return {
			importParams: { name: "RSASSA-PKCS1-v1_5", hash: hash ?? digest },
			verifyParams: { name: "RSASSA-PKCS1-v1_5" },
			label: `RSA ${bits}`,
			ecSize: null
		}
	}

	if (keyId === EC_KEY) {
		const curveParam: unknown = keyInfo.algorithm.algorithmParams
		const curve = curveParam instanceof asn1js.ObjectIdentifier ? CURVES.get(curveParam.valueBlock.toString()) : undefined
		const hash = ECDSA_SIGNATURES.get(signatureId)

		if (hash === "weak") return invalid("weakDigest")
		// Brainpool and other named curves WebCrypto has no import for.
		if (curve === undefined || hash === undefined) return { ok: false, state: "unverifiable" }

		return {
			importParams: { name: "ECDSA", namedCurve: curve.name },
			verifyParams: { name: "ECDSA", hash: hash ?? digest },
			label: `ECDSA ${curve.name}`,
			ecSize: curve.size
		}
	}

	if (keyId === ED25519 && (signatureId === ED25519 || signatureId === RSA_KEY)) {
		return { importParams: { name: "Ed25519" }, verifyParams: { name: "Ed25519" }, label: "Ed25519", ecSize: null }
	}

	return { ok: false, state: "unverifiable" }
}

function resolvePss(signer: SignerInfo, bits: number): ResolvedAlgorithm | CmsFailure {
	let params: RSASSAPSSParams

	try {
		params = new RSASSAPSSParams({ schema: signer.signatureAlgorithm.algorithmParams })
	} catch {
		return invalid("malformedSignature")
	}

	const hash = DIGESTS.get(params.hashAlgorithm.algorithmId)

	if (hash === "weak") return invalid("weakDigest")
	if (hash === undefined || params.trailerField !== 1) return { ok: false, state: "unverifiable" }

	if (params.maskGenAlgorithm.algorithmId !== MGF1) return { ok: false, state: "unverifiable" }

	let mgfHash: string

	try {
		mgfHash = mgf1Hash(params.maskGenAlgorithm.algorithmParams)
	} catch {
		return invalid("malformedSignature")
	}

	// WebCrypto's RSA-PSS uses MGF1 with the same hash.
	if (DIGESTS.get(mgfHash) !== hash) return { ok: false, state: "unverifiable" }

	return {
		importParams: { name: "RSA-PSS", hash },
		verifyParams: { name: "RSA-PSS", saltLength: params.saltLength },
		label: `RSA-PSS ${bits}`,
		ecSize: null
	}
}

function mgf1Hash(params: unknown): string {
	if (!(params instanceof asn1js.Sequence)) throw new Error("mgf1 parameters")

	const first = params.valueBlock.value[0]

	if (!(first instanceof asn1js.ObjectIdentifier)) throw new Error("mgf1 parameters")

	return first.valueBlock.toString()
}

// Bit length of the modulus of a DER RSAPublicKey.
function rsaBits(der: Uint8Array): number | null {
	let modulus: Uint8Array

	try {
		modulus = RSAPublicKey.fromBER(bytesOf(der)).modulus.valueBlock.valueHexView
	} catch {
		return null
	}

	let at = 0

	while (at < modulus.length && modulus[at] === 0) at++

	const top = modulus[at]

	return top === undefined ? 0 : (modulus.length - at - 1) * 8 + (32 - Math.clz32(top))
}

// ECDSA-Sig-Value (DER SEQUENCE of r and s) as WebCrypto's fixed-size r || s.
function ecdsaRaw(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> | null {
	const parsed = asn1js.fromBER(bytesOf(der))

	if (parsed.offset !== der.length || !(parsed.result instanceof asn1js.Sequence)) return null

	const [r, s, extra] = parsed.result.valueBlock.value

	if (!(r instanceof asn1js.Integer) || !(s instanceof asn1js.Integer) || extra !== undefined) return null

	const out = new Uint8Array(size * 2)

	for (const [i, part] of [r, s].entries()) {
		let value = part.valueBlock.valueHexView
		let at = 0

		while (at < value.length - 1 && value[at] === 0) at++

		value = value.subarray(at)

		if (value.length > size) return null

		out.set(value, size * (i + 1) - value.length)
	}

	return out
}

export interface TimestampToken {
	readonly cms: ParsedCms
	readonly info: TSTInfo
	readonly imprintDigest: PdfDigestName
}

// An RFC 3161 token: SignedData whose embedded content is a TSTInfo.
export function parseTimestampToken(der: Uint8Array): TimestampToken | CmsFailure {
	const parsed = parseCms(der)

	if (!parsed.ok) return parsed
	if (parsed.cms.contentType !== OID.tstInfo || parsed.cms.content === null) return invalid("malformedSignature")

	let info: TSTInfo

	try {
		info = TSTInfo.fromBER(bytesOf(parsed.cms.content))
	} catch {
		return invalid("malformedSignature")
	}

	const imprintDigest = DIGESTS.get(info.messageImprint.hashAlgorithm.algorithmId)

	if (imprintDigest === "weak") return invalid("weakDigest")
	if (imprintDigest === undefined) return { ok: false, state: "unverifiable" }

	return { cms: parsed.cms, info, imprintDigest }
}

// Checks a token's own signature (over its TSTInfo) and that it stamps `imprint` (the digest of what it covers).
export async function verifyTimestampToken(
	token: TimestampToken,
	imprint: Uint8Array,
	deps: PdfCryptoDeps
): Promise<CmsVerified | CmsFailure> {
	if (!equalBytes(token.info.messageImprint.hashedMessage.valueBlock.valueHexView, imprint)) return invalid("timestampMismatch")

	const { cms } = token

	if (cms.digest === "weak") return invalid("weakDigest")
	if (cms.digest === null || cms.content === null) return { ok: false, state: "unverifiable" }

	return verifyCms(cms, await digestBytes(cms.content, cms.digest, deps.createDigest), deps)
}

// The signature-timestamp token in the signer's unsigned attributes, if any.
export function signatureTimestamp(signer: SignerInfo): Uint8Array | null {
	const found = signer.unsignedAttrs?.attributes.find(item => item.type === OID.timeStampToken)
	const value: unknown = found?.values[0]

	return value instanceof asn1js.BaseBlock ? derOf(value) : null
}
