import { PDF_MAX_RANGE_LENGTH } from "@/components/pdfPreview/constants"

/**
 * Why a range request was refused. A closed set so the caller cannot leak a message built from
 * document-controlled values, and so each rejection is assertable in a test.
 */
export type RangeRejection = "notInteger" | "offsetOutOfRange" | "lengthOutOfBounds" | "exceedsFile" | "cumulativeLimit"

/**
 * Bounds for one read from the WebView-callable range reader.
 *
 * Extracted from the hook so it is testable without a filesystem: this is the security boundary for
 * the only function the viewer can call into, and "reviewed by eye" is not a sufficient guarantee for
 * something a hostile document can invoke at will.
 *
 * Rejects, never clamps. A clamped read returns fewer bytes than pdf.js asked for, which pdf.js
 * reports as a damaged document — so clamping would convert a bounds bug into a lie about the file.
 */
export function checkRangeRequest({
	offset,
	length,
	size,
	bytesRead,
	cumulativeLimit
}: {
	offset: number
	length: number
	size: number
	bytesRead: number
	cumulativeLimit: number
}): RangeRejection | null {
	if (!Number.isInteger(offset) || !Number.isInteger(length)) {
		return "notInteger"
	}

	if (offset < 0 || offset >= size) {
		return "offsetOutOfRange"
	}

	if (length <= 0 || length > PDF_MAX_RANGE_LENGTH) {
		return "lengthOutOfBounds"
	}

	if (offset + length > size) {
		return "exceedsFile"
	}

	// Reads are synchronous on the JS thread, so an unbounded caller stalls the whole app rather than
	// just the WebView. This is the one bound that does not follow from the others.
	if (bytesRead + length > cumulativeLimit) {
		return "cumulativeLimit"
	}

	return null
}

/**
 * True when the leading bytes are a PDF header. Kept separate from the reader so a mislabelled file
 * is refused with an honest message rather than surfacing as a pdf.js parse error.
 */
export function hasPdfMagic(header: string): boolean {
	return header === "%PDF-"
}
