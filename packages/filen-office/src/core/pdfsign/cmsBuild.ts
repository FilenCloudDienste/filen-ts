import * as asn1js from "asn1js"
import {
	AlgorithmIdentifier,
	Attribute,
	ContentInfo,
	EncapsulatedContentInfo,
	IssuerAndSerialNumber,
	RSASSAPSSParams,
	SignedAndUnsignedAttributes,
	SignedData,
	SignerInfo,
	createCMSECDSASignature,
	type Certificate
} from "pkijs"
import { OID, derOf, type PdfAlgorithm } from "./cms"
import { CURVES, DIGEST_ALGORITHMS, ED25519_OID, MGF1_OID, ownedBytes, RSA_PSS_OID, type PdfCurveName } from "./algorithms"
import type { PdfDigestName } from "./types"

// The CMS SignedData of a PDF signature we make (PAdES B-B, /SubFilter /ETSI.CAdES.detached): detached, one signer,
// signed attributes content-type, message-digest and signing-certificate-v2. No signing-time: the signature
// dictionary's /M states the claimed time. The private key never leaves the caller's WebCrypto key object.

// The WebCrypto calls the signer makes, typed structurally (no DOM types in the core).
export interface PdfSigningSubtle {
	importKey(
		format: "pkcs8" | "spki",
		keyData: Uint8Array<ArrayBuffer>,
		algorithm: PdfAlgorithm,
		extractable: boolean,
		keyUsages: ("sign" | "verify")[]
	): Promise<unknown>
	sign(algorithm: PdfAlgorithm, key: unknown, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
	verify(algorithm: PdfAlgorithm, key: unknown, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean>
	digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
}

// How a key signs: its WebCrypto algorithm and the digest of the signed bytes (the digest is fixed per key type, as
// PAdES baseline expects: SHA-256 for RSA and P-256, SHA-384 for P-384, SHA-512 for P-521 and Ed25519).
export type PdfSignatureScheme =
	| { readonly name: "RSASSA-PKCS1-v1_5"; readonly digest: PdfDigestName; readonly bits: number }
	| { readonly name: "RSA-PSS"; readonly digest: PdfDigestName; readonly bits: number }
	| { readonly name: "ECDSA"; readonly digest: PdfDigestName; readonly curve: PdfCurveName }
	| { readonly name: "Ed25519"; readonly digest: "SHA-512" }

// What signing needs: a non-extractable private key and the certificates. `chain` starts with the signer's own.
export interface PdfSigningIdentity {
	readonly key: unknown
	readonly scheme: PdfSignatureScheme
	readonly chain: readonly Certificate[]
}

const SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47"
// The signed attributes and identifiers around the certificates and the signature value, with room to spare.
const CMS_OVERHEAD_BYTES = 1024

// The WebCrypto parameters of importing (`import`) and signing with (`sign`) a scheme's key.
export function schemeParams(scheme: PdfSignatureScheme): { readonly import: PdfAlgorithm; readonly sign: PdfAlgorithm } {
	switch (scheme.name) {
		case "RSASSA-PKCS1-v1_5":
			return { import: { name: scheme.name, hash: scheme.digest }, sign: { name: scheme.name } }
		case "RSA-PSS":
			return {
				import: { name: scheme.name, hash: scheme.digest },
				sign: { name: scheme.name, saltLength: DIGEST_ALGORITHMS[scheme.digest].bytes }
			}
		case "ECDSA":
			return { import: { name: "ECDSA", namedCurve: scheme.curve }, sign: { name: "ECDSA", hash: scheme.digest } }
		case "Ed25519":
			return { import: { name: "Ed25519" }, sign: { name: "Ed25519" } }
	}
}

// Size of a scheme's signature value in DER.
function signatureBytes(scheme: PdfSignatureScheme): number {
	switch (scheme.name) {
		case "RSASSA-PKCS1-v1_5":
		case "RSA-PSS":
			return Math.ceil(scheme.bits / 8)
		case "ECDSA":
			// SEQUENCE of two INTEGERs, each possibly one byte longer for its sign.
			return CURVES[scheme.curve].size * 2 + 9
		case "Ed25519":
			return 64
	}
}

// Bytes the signature's DER may take: what /Contents is sized for (twice that in hex). Generous, so the second pass
// (a larger placeholder when the CMS does not fit) stays the exception.
export function cmsCapacity(identity: PdfSigningIdentity): number {
	const certificates = identity.chain.reduce((sum, certificate) => sum + derOf(certificate.toSchema()).length, 0)
	const signer = identity.chain[0]
	const issuer = signer === undefined ? 0 : derOf(signer.issuer.toSchema()).length

	// The signer's issuer and serial appear twice: the signer identifier and the signing-certificate-v2 attribute.
	return certificates + signatureBytes(identity.scheme) + issuer * 2 + CMS_OVERHEAD_BYTES
}

// Signs a test message and checks it with `certificate`'s key: proves the key and the certificate belong together.
export async function keyMatchesCertificate(
	key: unknown,
	scheme: PdfSignatureScheme,
	certificate: Certificate,
	subtle: PdfSigningSubtle,
	spki: (certificate: Certificate) => Uint8Array
): Promise<boolean> {
	const params = schemeParams(scheme)
	const message = new Uint8Array(32).map((_, i) => i * 7 + 1)
	let publicKey: unknown

	try {
		publicKey = await subtle.importKey("spki", ownedBytes(spki(certificate)), params.import, false, ["verify"])
	} catch {
		return false
	}

	const signature = new Uint8Array(await subtle.sign(params.sign, key, message))

	try {
		return await subtle.verify(params.sign, publicKey, signature, message)
	} catch {
		return false
	}
}

function digestAlgorithm(digest: PdfDigestName): AlgorithmIdentifier {
	return new AlgorithmIdentifier({ algorithmId: DIGEST_ALGORITHMS[digest].oid })
}

function signatureAlgorithm(scheme: PdfSignatureScheme): AlgorithmIdentifier {
	switch (scheme.name) {
		case "RSASSA-PKCS1-v1_5":
			return new AlgorithmIdentifier({ algorithmId: DIGEST_ALGORITHMS[scheme.digest].rsaOid, algorithmParams: new asn1js.Null() })
		case "RSA-PSS": {
			const hash = new AlgorithmIdentifier({ algorithmId: DIGEST_ALGORITHMS[scheme.digest].oid, algorithmParams: new asn1js.Null() })
			const params = new RSASSAPSSParams({
				hashAlgorithm: hash,
				maskGenAlgorithm: new AlgorithmIdentifier({ algorithmId: MGF1_OID, algorithmParams: hash.toSchema() }),
				saltLength: DIGEST_ALGORITHMS[scheme.digest].bytes
			})

			return new AlgorithmIdentifier({ algorithmId: RSA_PSS_OID, algorithmParams: params.toSchema() })
		}
		case "ECDSA":
			return new AlgorithmIdentifier({ algorithmId: DIGEST_ALGORITHMS[scheme.digest].ecdsaOid })
		case "Ed25519":
			return new AlgorithmIdentifier({ algorithmId: ED25519_OID })
	}
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length)

	for (let i = 0; i < length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0)

	return a.length - b.length
}

// ESS signing-certificate-v2 (RFC 5035): the SHA-256 of the signer's certificate (the default algorithm, so left out)
// with its issuer and serial number, binding the signature to that certificate.
async function signingCertificateV2(certificate: Certificate, subtle: PdfSigningSubtle): Promise<Attribute> {
	const hash = new Uint8Array(await subtle.digest("SHA-256", ownedBytes(derOf(certificate.toSchema()))))
	const directoryName = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 4 }, value: [certificate.issuer.toSchema()] })
	const issuerSerial = new asn1js.Sequence({
		value: [
			new asn1js.Sequence({ value: [directoryName] }),
			new asn1js.Integer({ valueHex: ownedBytes(certificate.serialNumber.valueBlock.valueHexView) })
		]
	})
	const certId = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: hash }), issuerSerial] })

	return new Attribute({
		type: SIGNING_CERTIFICATE_V2,
		values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [certId] })] })]
	})
}

// The DER ContentInfo of a detached SignedData over a PDF's byte ranges whose digest (with `identity.scheme.digest`)
// is `digest`.
export async function buildPdfCms(identity: PdfSigningIdentity, digest: Uint8Array, subtle: PdfSigningSubtle): Promise<Uint8Array> {
	const [signer] = identity.chain

	if (signer === undefined) throw new Error("no signer certificate")
	if (digest.length !== DIGEST_ALGORITHMS[identity.scheme.digest].bytes) throw new Error("digest length")

	const attributes = [
		new Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
		new Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: ownedBytes(digest) })] }),
		await signingCertificateV2(signer, subtle)
	]
	// DER orders a SET OF by its members' encodings.
	const encoded = attributes.map(attribute => ({ attribute, der: derOf(attribute.toSchema()) }))

	encoded.sort((a, b) => compareBytes(a.der, b.der))

	const signedAttrs = new SignedAndUnsignedAttributes({ type: 0, attributes: encoded.map(item => item.attribute) })
	// What is signed: the attributes as a SET (the [0] IMPLICIT tag of their place in SignerInfo replaced).
	const toSign = ownedBytes(derOf(signedAttrs.toSchema()))

	toSign[0] = 0x31

	const params = schemeParams(identity.scheme)
	let signature = await subtle.sign(params.sign, identity.key, toSign)

	if (identity.scheme.name === "ECDSA") signature = createCMSECDSASignature(signature)

	const signedData = new SignedData({
		version: 1,
		digestAlgorithms: [digestAlgorithm(identity.scheme.digest)],
		encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID.data }),
		certificates: [...identity.chain],
		signerInfos: [
			new SignerInfo({
				version: 1,
				sid: new IssuerAndSerialNumber({ issuer: signer.issuer, serialNumber: signer.serialNumber }),
				digestAlgorithm: digestAlgorithm(identity.scheme.digest),
				signedAttrs,
				signatureAlgorithm: signatureAlgorithm(identity.scheme),
				signature: new asn1js.OctetString({ valueHex: signature })
			})
		]
	})

	return derOf(new ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) }).toSchema())
}
