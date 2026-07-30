import { describe, expect, test } from "vitest"
import { checkRangeRequest, hasPdfMagic } from "@/components/pdfPreview/rangeGuard"
import { PDF_MAX_RANGE_LENGTH } from "@/components/pdfPreview/constants"

const SIZE = 10 * 1024 * 1024
const LIMIT = SIZE * 4

function check(overrides: Partial<Parameters<typeof checkRangeRequest>[0]> = {}) {
	return checkRangeRequest({
		offset: 0,
		length: 1024,
		size: SIZE,
		bytesRead: 0,
		cumulativeLimit: LIMIT,
		...overrides
	})
}

/**
 * This is the security boundary for the only function the WebView can call into. A hostile document
 * that achieves script execution calls it directly, with whatever arguments it likes.
 */
describe("checkRangeRequest", () => {
	test("allows an ordinary read", () => {
		expect(check()).toBeNull()
		expect(check({ offset: SIZE - 1, length: 1 })).toBeNull()
		expect(check({ length: PDF_MAX_RANGE_LENGTH })).toBeNull()
	})

	test("rejects non-integers, including the shapes that coerce", () => {
		for (const value of [1.5, NaN, Infinity, -Infinity]) {
			expect(check({ offset: value })).toBe("notInteger")
			expect(check({ length: value })).toBe("notInteger")
		}
	})

	test("rejects reads outside the file", () => {
		expect(check({ offset: -1 })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE + 1024 })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE - 10, length: 1024 })).toBe("exceedsFile")
	})

	test("rejects an oversized or empty length", () => {
		expect(check({ length: 0 })).toBe("lengthOutOfBounds")
		expect(check({ length: -1 })).toBe("lengthOutOfBounds")
		expect(check({ length: PDF_MAX_RANGE_LENGTH + 1 })).toBe("lengthOutOfBounds")
	})

	test("rejects once the cumulative budget is spent", () => {
		// Reads are synchronous on the JS thread, so without this a caller can stall the whole app
		// rather than merely its own WebView.
		expect(check({ bytesRead: LIMIT, length: 1 })).toBe("cumulativeLimit")
		expect(check({ bytesRead: LIMIT - 512, length: 1024 })).toBe("cumulativeLimit")
		expect(check({ bytesRead: LIMIT - 1024, length: 1024 })).toBeNull()
	})

	test("never clamps — every refusal is a rejection", () => {
		// A clamped read returns fewer bytes than pdf.js asked for, which it reports as a damaged
		// document. Bounds failures must not be able to masquerade as a corrupt file.
		const past = check({ offset: SIZE - 10, length: 4096 })

		expect(past).not.toBeNull()
		expect(past).toBe("exceedsFile")
	})

	test("does not accept a path or any extra argument by shape", () => {
		// The reader takes (offset, length) and nothing else; a path parameter would make it an
		// arbitrary-file-read primitive.
		expect(checkRangeRequest.length).toBe(1)
	})
})

describe("hasPdfMagic", () => {
	test("accepts only a real header", () => {
		expect(hasPdfMagic("%PDF-")).toBe(true)
		expect(hasPdfMagic("%pdf-")).toBe(false)
		expect(hasPdfMagic("PK")).toBe(false)
		expect(hasPdfMagic("")).toBe(false)
		expect(hasPdfMagic("%PDF")).toBe(false)
	})
})
