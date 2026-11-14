import { signatureSummary, type PdfSignatureSummaryState } from "@filen/office/core/pdfsign/summary"
import type {
	PdfChangeKind,
	PdfSignatureInfo,
	PdfSignatureInvalidReason,
	PdfSignatureReport,
	PdfSignatureUnverifiableReason
} from "@filen/office/core/pdfsign"

// What the signature status line and the Signatures dialog say about a verification report, as catalog keys. Only
// types and the summary come from @filen/office here: the verifier itself (pkijs, MuPDF) runs in a worker.

export type SignatureBannerKey =
	| "previewPdfSignatureBannerUnchanged"
	| "previewPdfSignatureBannerChangedAllowed"
	| "previewPdfSignatureBannerChangedNotAllowed"
	| "previewPdfSignatureBannerInvalid"
	| "previewPdfSignatureBannerUnverifiable"

const BANNER_KEYS: Readonly<Record<PdfSignatureSummaryState, SignatureBannerKey>> = {
	unchanged: "previewPdfSignatureBannerUnchanged",
	changedAllowed: "previewPdfSignatureBannerChangedAllowed",
	changedNotAllowed: "previewPdfSignatureBannerChangedNotAllowed",
	invalid: "previewPdfSignatureBannerInvalid",
	unverifiable: "previewPdfSignatureBannerUnverifiable"
}

export const INVALID_REASON_KEYS = {
	byteRange: "previewPdfSignatureInvalidByteRange",
	contentsGap: "previewPdfSignatureInvalidContentsGap",
	notAtRevisionEnd: "previewPdfSignatureInvalidNotAtRevisionEnd",
	dictionaryChanged: "previewPdfSignatureInvalidDictionaryChanged",
	malformedSignature: "previewPdfSignatureInvalidMalformed",
	signerCount: "previewPdfSignatureInvalidSignerCount",
	notDetached: "previewPdfSignatureInvalidNotDetached",
	digestMismatch: "previewPdfSignatureInvalidDigest",
	signatureMismatch: "previewPdfSignatureInvalidSignature",
	weakDigest: "previewPdfSignatureInvalidWeakDigest",
	weakKey: "previewPdfSignatureInvalidWeakKey",
	unsupportedSubFilter: "previewPdfSignatureInvalidSubFilter",
	certificateMissing: "previewPdfSignatureInvalidCertificateMissing",
	timestampMismatch: "previewPdfSignatureInvalidTimestamp"
} as const satisfies Record<PdfSignatureInvalidReason, string>

export const UNVERIFIABLE_REASON_KEYS = {
	algorithm: "previewPdfSignatureUnverifiableAlgorithm",
	parserMismatch: "previewPdfSignatureUnverifiableParserMismatch",
	damaged: "previewPdfSignatureUnverifiableDamaged",
	readFailed: "previewPdfSignatureUnverifiableReadFailed"
} as const satisfies Record<PdfSignatureUnverifiableReason, string>

export const CHANGE_KIND_KEYS = {
	form: "previewPdfSignatureChangeForm",
	annotation: "previewPdfSignatureChangeAnnotation",
	signature: "previewPdfSignatureChangeSignature",
	dss: "previewPdfSignatureChangeDss",
	content: "previewPdfSignatureChangeContent"
} as const satisfies Record<PdfChangeKind, string>

export type SignatureReasonKey =
	(typeof INVALID_REASON_KEYS)[PdfSignatureInvalidReason] | (typeof UNVERIFIABLE_REASON_KEYS)[PdfSignatureUnverifiableReason]

export type SignatureStateKey =
	| "previewPdfSignatureStateUnchanged"
	| "previewPdfSignatureStateChanged"
	| "previewPdfSignatureStateInvalid"
	| "previewPdfSignatureStateUnverifiable"

// The name shown for a signer: the certificate's common name, its organisation, then the name the signer typed.
export function signerName(signature: PdfSignatureInfo): string | null {
	return signature.signer?.commonName ?? signature.signer?.organization ?? signature.name
}

export function reasonKey(signature: PdfSignatureInfo): SignatureReasonKey | null {
	if (signature.state === "invalid" && signature.invalidReason !== null) return INVALID_REASON_KEYS[signature.invalidReason]
	if (signature.state === "unverifiable") return UNVERIFIABLE_REASON_KEYS[signature.unverifiableReason ?? "readFailed"]

	return null
}

export function stateKey(signature: PdfSignatureInfo): SignatureStateKey {
	switch (signature.state) {
		case "unchanged":
			return "previewPdfSignatureStateUnchanged"
		case "changed":
			return "previewPdfSignatureStateChanged"
		case "invalid":
			return "previewPdfSignatureStateInvalid"
		case "unverifiable":
			return "previewPdfSignatureStateUnverifiable"
	}
}

export type CertificationKey =
	"previewPdfSignatureCertifiedNone" | "previewPdfSignatureCertifiedForms" | "previewPdfSignatureCertifiedAnnotations"

export function certificationKey(level: PdfSignatureInfo["certification"]): CertificationKey | null {
	switch (level) {
		case 1:
			return "previewPdfSignatureCertifiedNone"
		case 2:
			return "previewPdfSignatureCertifiedForms"
		case 3:
			return "previewPdfSignatureCertifiedAnnotations"
		case null:
			return null
	}
}

export interface SignatureBanner {
	readonly state: PdfSignatureSummaryState
	readonly key: SignatureBannerKey
	readonly signature: PdfSignatureInfo
	readonly name: string | null
	readonly reason: SignatureReasonKey | null
	// The signed revision can be shown: the signature verified and later revisions followed it.
	readonly signedLength: number | null
}

// The status line for a report: its most serious signature. Null when the document has none.
export function signatureBanner(report: PdfSignatureReport): SignatureBanner | null {
	const summary = signatureSummary(report)

	if (summary === null) return null

	const { signature } = summary

	return {
		state: summary.state,
		key: BANNER_KEYS[summary.state],
		signature,
		name: signerName(signature),
		reason: reasonKey(signature),
		signedLength: signature.state === "changed" && signature.signedLength > 0 ? signature.signedLength : null
	}
}
