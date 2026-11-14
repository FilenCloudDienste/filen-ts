import type { PdfCertificateInfo } from "@filen/office/core/pdfsign"
import type { PdfSignerLoadFailure, PdfSignerSummary, PdfSignerUnlock } from "@/features/pdf/workers/pdfSignerCore"
import type { PdfSigner } from "@/features/pdf/signing/signerClient"

// What the certificate signing dialog chooses, and the catalog keys it shows. Types only from the signer: its worker
// carries the PKCS#12 and CMS libraries.

export const SIGNING_REASONS = ["none", "approve", "reviewed", "author", "attest", "agree"] as const
export type SigningReason = (typeof SIGNING_REASONS)[number]

export const SIGNING_REASON_KEYS = {
	none: "previewPdfSigningReasonNone",
	approve: "previewPdfSigningReasonApprove",
	reviewed: "previewPdfSigningReasonReviewed",
	author: "previewPdfSigningReasonAuthor",
	attest: "previewPdfSigningReasonAttest",
	agree: "previewPdfSigningReasonAgree"
} as const satisfies Record<SigningReason, string>

export const SIGNING_APPEARANCES = ["nameDate", "details", "visual"] as const
export type SigningAppearance = (typeof SIGNING_APPEARANCES)[number]

export const SIGNING_APPEARANCE_KEYS = {
	nameDate: "previewPdfSigningAppearanceNameDate",
	details: "previewPdfSigningAppearanceDetails",
	visual: "previewPdfSigningAppearanceVisual"
} as const satisfies Record<SigningAppearance, string>

export const SIGNING_CERTIFY = ["none", "1", "2", "3"] as const
export type SigningCertify = (typeof SIGNING_CERTIFY)[number]

export const SIGNING_CERTIFY_KEYS = {
	none: "previewPdfSigningCertifyNone",
	"1": "previewPdfSigningCertifyNoChanges",
	"2": "previewPdfSigningCertifyForms",
	"3": "previewPdfSigningCertifyAnnotations"
} as const satisfies Record<SigningCertify, string>

export const SIGNING_ERROR_KEYS = {
	password: "previewPdfSigningErrorPassword",
	malformed: "previewPdfSigningErrorMalformed",
	noKey: "previewPdfSigningErrorNoKey",
	noCertificate: "previewPdfSigningErrorNoCertificate",
	algorithm: "previewPdfSigningErrorAlgorithm",
	weakKey: "previewPdfSigningErrorWeakKey",
	keyMismatch: "previewPdfSigningErrorKeyMismatch",
	readFailed: "previewPdfSigningErrorReadFailed",
	tooLarge: "previewPdfSigningErrorTooLarge",
	notLoaded: "previewPdfSigningErrorReadFailed"
} as const satisfies Record<Extract<PdfSignerUnlock, { ok: false }>["reason"] | PdfSignerLoadFailure, string>

export type SigningErrorKey = (typeof SIGNING_ERROR_KEYS)[keyof typeof SIGNING_ERROR_KEYS]

export interface PdfCertificateSigningOptions {
	// The reason written into the signature (/Reason), as shown; null for none.
	readonly reason: string | null
	readonly location: string | null
	readonly appearance: SigningAppearance
	// A DocMDP certification level, or null for an approval signature.
	readonly certify: 1 | 2 | 3 | null
}

// What the dialog hands over: the unlocked signer (terminate it after signing) and the choices.
export interface PdfCertificateSigning {
	readonly signer: PdfSigner
	readonly summary: PdfSignerSummary
	readonly options: PdfCertificateSigningOptions
}

export function certifyLevel(choice: SigningCertify): 1 | 2 | 3 | null {
	return choice === "none" ? null : choice === "1" ? 1 : choice === "2" ? 2 : 3
}

export function isCertificateFileName(name: string): boolean {
	return /\.(p12|pfx)$/i.test(name)
}

export type CertificateValidity = "valid" | "expired" | "notYetValid"

export function certificateValidity(certificate: PdfCertificateInfo, now: number): CertificateValidity {
	if (now > certificate.notAfter) return "expired"
	if (now < certificate.notBefore) return "notYetValid"

	return "valid"
}

// The name the signature shows: the certificate's common name, else its whole subject.
export function signerDisplayName(certificate: PdfCertificateInfo): string {
	return certificate.commonName ?? certificate.organization ?? certificate.subject
}

export interface SigningStampText {
	signedBy(name: string): string
	date(date: string): string
	reason(reason: string): string
}

// The lines of text inside the placed signature, top to bottom.
export function signatureStampLines(
	summary: PdfSignerSummary,
	options: PdfCertificateSigningOptions,
	formattedDate: string,
	text: SigningStampText
): string[] {
	const lines = [text.signedBy(signerDisplayName(summary.signer)), text.date(formattedDate)]

	if (options.appearance === "details" && options.reason !== null) lines.push(text.reason(options.reason))

	return lines
}
