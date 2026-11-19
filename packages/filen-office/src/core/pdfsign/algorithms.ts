import type { PdfDigestName } from "./types"

// The algorithms a certificate signature uses, shared by import (pkcs12.ts), signing (cmsBuild.ts) and verification
// (cms.ts). They must agree: a key the import accepts has to sign what the app's own verifier calls valid.

export const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1"
export const RSA_PSS_OID = "1.2.840.113549.1.1.10"
export const MGF1_OID = "1.2.840.113549.1.1.8"
export const EC_PUBLIC_KEY_OID = "1.2.840.10045.2.1"
export const ED25519_OID = "1.3.101.112"
// An RFC 3161 timestamp token as an unsigned attribute (id-aa-timeStampToken).
export const TIMESTAMP_TOKEN_OID = "1.2.840.113549.1.9.16.2.14"

// RSA keys below this verify as weak, so the import refuses them.
export const MIN_RSA_BITS = 2048

export type PdfCurveName = "P-256" | "P-384" | "P-521"

export interface PdfDigestAlgorithm {
	readonly name: PdfDigestName
	readonly oid: string
	readonly bytes: number
	// sha*WithRSAEncryption and ecdsa-with-SHA* with this digest.
	readonly rsaOid: string
	readonly ecdsaOid: string
}

export interface PdfCurve {
	readonly name: PdfCurveName
	readonly oid: string
	// Bytes of a coordinate (r and s each in a signature).
	readonly size: number
	// The digest PAdES baseline pairs with the curve.
	readonly digest: PdfDigestName
}

export const DIGEST_ALGORITHMS: Readonly<Record<PdfDigestName, PdfDigestAlgorithm>> = {
	"SHA-256": {
		name: "SHA-256",
		oid: "2.16.840.1.101.3.4.2.1",
		bytes: 32,
		rsaOid: "1.2.840.113549.1.1.11",
		ecdsaOid: "1.2.840.10045.4.3.2"
	},
	"SHA-384": {
		name: "SHA-384",
		oid: "2.16.840.1.101.3.4.2.2",
		bytes: 48,
		rsaOid: "1.2.840.113549.1.1.12",
		ecdsaOid: "1.2.840.10045.4.3.3"
	},
	"SHA-512": {
		name: "SHA-512",
		oid: "2.16.840.1.101.3.4.2.3",
		bytes: 64,
		rsaOid: "1.2.840.113549.1.1.13",
		ecdsaOid: "1.2.840.10045.4.3.4"
	}
}

export const CURVES: Readonly<Record<PdfCurveName, PdfCurve>> = {
	"P-256": { name: "P-256", oid: "1.2.840.10045.3.1.7", size: 32, digest: "SHA-256" },
	"P-384": { name: "P-384", oid: "1.3.132.0.34", size: 48, digest: "SHA-384" },
	"P-521": { name: "P-521", oid: "1.3.132.0.35", size: 66, digest: "SHA-512" }
}

export const CURVE_BY_OID: ReadonlyMap<string, PdfCurve> = new Map(Object.values(CURVES).map(curve => [curve.oid, curve]))

// Bit length of an RSA modulus given as its big-endian bytes (leading zero bytes allowed).
export function rsaModulusBits(modulus: Uint8Array): number {
	let at = 0

	while (at < modulus.length && modulus[at] === 0) at++

	const top = modulus[at]

	return top === undefined ? 0 : (modulus.length - at - 1) * 8 + (32 - Math.clz32(top))
}

// A copy that owns its ArrayBuffer, as WebCrypto and pkijs take.
export function ownedBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(view)
}
