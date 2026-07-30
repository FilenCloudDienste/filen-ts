import { type PdfErrorKind, type PdfPasswordReason } from "@/components/pdfPreview/protocol"

/**
 * Maps a pdf.js exception onto our closed error set.
 *
 * Duck-typed on `name` rather than `instanceof`, because these classes live in the DOM bundle and the
 * check has to work for values that crossed a bundle boundary or were re-thrown.
 *
 * The password case is deliberately NOT an error: it is a prompt. It is returned separately so the
 * caller cannot accidentally render "failed to open" for a document that simply needs a password.
 *
 * Nothing here propagates a pdf.js message string. A document controls parts of those, and they reach
 * both the UI and the persisted log.
 */
export type PdfErrorClassification = { type: "password"; reason: PdfPasswordReason } | { type: "error"; kind: PdfErrorKind } | { type: "aborted" }

// pdf.js PasswordResponses: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD.
const INCORRECT_PASSWORD = 2

export function classifyPdfError(error: unknown): PdfErrorClassification {
	if (typeof error !== "object" || error === null) {
		return {
			type: "error",
			kind: "unknown"
		}
	}

	const name = (error as { name?: unknown }).name
	const code = (error as { code?: unknown }).code

	switch (name) {
		case "PasswordException": {
			return {
				type: "password",
				reason: code === INCORRECT_PASSWORD ? "incorrect" : "required"
			}
		}

		case "InvalidPDFException": {
			return {
				type: "error",
				kind: "invalidDocument"
			}
		}

		// 6.x folded MissingPDFException and UnexpectedResponseException into this one; neither class
		// exists any more, so matching on them would silently never fire.
		case "ResponseException": {
			return {
				type: "error",
				kind: "transportFailed"
			}
		}

		// A cancelled render is the expected outcome of scrolling away from a page, not a failure.
		case "RenderingCancelledException":
		case "AbortException": {
			return {
				type: "aborted"
			}
		}

		default: {
			return {
				type: "error",
				kind: "unknown"
			}
		}
	}
}
