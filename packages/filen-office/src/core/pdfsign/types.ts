// What verifying a PDF's signatures reports. Plain data (numbers, strings, arrays), so it crosses a worker boundary as
// is. Times are milliseconds since the epoch.

// "unchanged": the signed bytes verify and nothing was added after them. "changed": they verify, and later revisions
// exist (allowed or not by the signer's permissions). "invalid": an integrity or cryptographic check failed.
// "unverifiable": the check could not be made here (an algorithm this runtime lacks, a damaged file, two readings of
// the file that disagree).
export type PdfSignatureState = "unchanged" | "changed" | "invalid" | "unverifiable"

export type PdfSignatureInvalidReason =
	// /ByteRange is not four non-negative integers starting at 0 that fit the file.
	| "byteRange"
	// The bytes left out are not exactly the hex string of /Contents.
	| "contentsGap"
	// The second range does not end at a revision's %%EOF.
	| "notAtRevisionEnd"
	// The signature dictionary is not where the signed bytes put it, or a later revision replaced it.
	| "dictionaryChanged"
	| "malformedSignature"
	// Not exactly one signer.
	| "signerCount"
	// The signed content is embedded instead of being the file's bytes.
	| "notDetached"
	| "digestMismatch"
	| "signatureMismatch"
	// SHA-1 or MD5.
	| "weakDigest"
	// RSA shorter than 2048 bits.
	| "weakKey"
	| "unsupportedSubFilter"
	| "certificateMissing"
	// A timestamp token that does not cover what it claims to.
	| "timestampMismatch"

export type PdfSignatureUnverifiableReason =
	// An algorithm this runtime's WebCrypto cannot check (Brainpool curves, Ed25519 where missing).
	| "algorithm"
	// The PDF parsers disagree about which signature fields exist.
	| "parserMismatch"
	// The file needed repair to open, so its revisions cannot be trusted.
	| "damaged"
	| "readFailed"

// What a later revision changed, judged object by object against the signed revision.
export type PdfChangeKind = "form" | "annotation" | "signature" | "dss" | "content"

export type PdfDigestName = "SHA-256" | "SHA-384" | "SHA-512"

export interface PdfCertificateInfo {
	// RFC 4514-style distinguished names.
	readonly subject: string
	readonly issuer: string
	readonly commonName: string | null
	readonly organization: string | null
	// Hex, upper case.
	readonly serial: string
	readonly notBefore: number
	readonly notAfter: number
	readonly selfSigned: boolean
}

export interface PdfSignatureChanges {
	// Every change is one the signer's permissions (certification level, field locks) allow.
	readonly allowed: boolean
	readonly kinds: readonly PdfChangeKind[]
}

export interface PdfSignatureInfo {
	// The field's fully qualified name.
	readonly field: string
	// Zero-based page of the field's first widget, and its rectangle in PDF units; null when unplaced.
	readonly page: number | null
	readonly rect: readonly [number, number, number, number] | null
	// A signature, or a document timestamp (ETSI.RFC3161).
	readonly kind: "signature" | "timestamp"
	readonly subFilter: string
	readonly state: PdfSignatureState
	readonly invalidReason: PdfSignatureInvalidReason | null
	readonly unverifiableReason: PdfSignatureUnverifiableReason | null
	// Set for "changed".
	readonly changes: PdfSignatureChanges | null
	// Length of the byte prefix that is the signed revision: opening it shows the document as signed.
	readonly signedLength: number
	// 1-based revision the signature closes, of `revisions` in the file.
	readonly revision: number
	readonly signer: PdfCertificateInfo | null
	// Signer first, then each issuer found among the signature's certificates.
	readonly chain: readonly PdfCertificateInfo[]
	readonly name: string | null
	readonly reason: string | null
	readonly location: string | null
	readonly contactInfo: string | null
	// The signer's own claim (/M, else the signing-time attribute): never a trusted time.
	readonly claimedTime: number | null
	// An embedded RFC 3161 time, whose authority is not verified.
	readonly timestampTime: number | null
	// The certification level (DocMDP /P) when this is the document's certifying signature.
	readonly certification: 1 | 2 | 3 | null
	readonly digest: PdfDigestName | null
	// "RSA 2048", "RSA-PSS 3072", "ECDSA P-256", "Ed25519".
	readonly algorithm: string | null
	readonly expiredAtClaimedTime: boolean
	readonly notYetValidAtClaimedTime: boolean
}

export interface PdfSignatureReport {
	readonly signatures: readonly PdfSignatureInfo[]
	readonly revisions: number
	// A Document Security Store (validation data) is present; shown, never used.
	readonly dss: boolean
}
