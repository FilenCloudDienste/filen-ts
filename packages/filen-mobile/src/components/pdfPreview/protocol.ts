/**
 * The complete WebView <-> native message contract for the PDF viewer.
 *
 * One module, because the alternative was tried: three parts of the design each defined their own
 * envelope set, and the sets disagreed. The concrete failure that produced was a viewer that could
 * report "this WebView cannot run me" through a message the native side did not know about, drop it,
 * and leave the user on a spinner forever — silent, and unfixable without a store release.
 *
 * Two rules hold for everything below:
 *
 *  1. The WebView is the untrusted side. Every inbound payload is re-validated here, never trusted
 *     because the viewer "just sent it".
 *  2. `PdfViewerEventKind` is CLOSED. No pdf.js error string ever reaches the UI or the log through
 *     this channel — a document controls parts of those strings.
 *
 * The link-tap envelope is shared with the .docx preview and lives in `@/lib/domExternalLink`.
 *
 * No DOM or native imports, so both sides share one definition and it is testable in node.
 */

export const PDF_EVENT_KEY = "__filenPdfEvent"

/**
 * Why the viewer cannot run at all in this WebView. Distinct from a document-level error: the user
 * gets a "cannot preview here" state rather than a retry, because retrying cannot help.
 */
export type PdfUnsupportedReason = "structuredClone" | "canvas"

/**
 * Closed set of document-level failures. Mapped from pdf.js exceptions by `errors.ts`; the UI picks a
 * localized string per kind.
 */
export type PdfErrorKind = "invalidDocument" | "transportFailed" | "renderFailed" | "unknown"

export type PdfPasswordReason = "required" | "incorrect"

/**
 * Everything the viewer reports. `ready` and `unsupported` are contract, not optional extras — the
 * boot handshake and the capability gate depend on both existing.
 */
export type PdfViewerEvent =
	| { event: "ready" }
	| { event: "edited" }
	| { event: "saved"; requestId: string; byteLength: number }
	| { event: "saveFailed"; requestId: string }
	| { event: "unsupported"; reason: PdfUnsupportedReason }
	| { event: "firstPagePainted" }
	| { event: "passwordRequired"; requestId: string; reason: PdfPasswordReason }
	| { event: "error"; kind: PdfErrorKind }

/**
 * Native -> WebView. Delivered as a prop AFTER mount, never at mount: mount-time props are serialized
 * into the WebView's initial-props global, and a document password must not live there. Nulled by the
 * host once consumed.
 */
export type PdfPasswordResponse = {
	requestId: string
	password: string
}

/**
 * Native -> WebView. Set when the user has asked to save; the viewer serialises the document and
 * streams it back through the write RPC, then reports `saved` or `saveFailed` for this requestId.
 */
export type PdfSaveRequest = {
	requestId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

const UNSUPPORTED_REASONS: readonly PdfUnsupportedReason[] = ["structuredClone", "canvas"]
const ERROR_KINDS: readonly PdfErrorKind[] = ["invalidDocument", "transportFailed", "renderFailed", "unknown"]
const PASSWORD_REASONS: readonly PdfPasswordReason[] = ["required", "incorrect"]

/**
 * Native-side parser for a viewer event. Returns null for anything that is not a well-formed member
 * of the closed set, so an unrecognised or malformed message is ignored rather than acted on.
 */
export function parsePdfViewerEvent(parsed: unknown): PdfViewerEvent | null {
	if (!isRecord(parsed) || !(PDF_EVENT_KEY in parsed)) {
		return null
	}

	const envelope = parsed[PDF_EVENT_KEY]

	if (!isRecord(envelope)) {
		return null
	}

	const event = envelope["event"]

	switch (event) {
		case "ready":
		case "edited":
		case "firstPagePainted": {
			return {
				event
			}
		}

		case "saved": {
			const requestId = envelope["requestId"]
			const byteLength = envelope["byteLength"]

			return typeof requestId === "string" &&
				requestId.length > 0 &&
				requestId.length <= 64 &&
				typeof byteLength === "number" &&
				Number.isInteger(byteLength) &&
				byteLength > 0
				? {
						event,
						requestId,
						byteLength
					}
				: null
		}

		case "saveFailed": {
			const requestId = envelope["requestId"]

			return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 64
				? {
						event,
						requestId
					}
				: null
		}

		case "unsupported": {
			const reason = envelope["reason"]

			return UNSUPPORTED_REASONS.includes(reason as PdfUnsupportedReason)
				? {
						event,
						reason: reason as PdfUnsupportedReason
					}
				: null
		}

		case "passwordRequired": {
			const requestId = envelope["requestId"]
			const reason = envelope["reason"]

			return typeof requestId === "string" &&
				requestId.length > 0 &&
				requestId.length <= 64 &&
				PASSWORD_REASONS.includes(reason as PdfPasswordReason)
				? {
						event,
						requestId,
						reason: reason as PdfPasswordReason
					}
				: null
		}

		case "error": {
			const kind = envelope["kind"]

			return ERROR_KINDS.includes(kind as PdfErrorKind)
				? {
						event,
						kind: kind as PdfErrorKind
					}
				: null
		}

		default: {
			return null
		}
	}
}
