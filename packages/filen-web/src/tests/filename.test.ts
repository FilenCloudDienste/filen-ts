import { describe, expect, it } from "vitest"
import { contentDispositionAttachment, sanitizeFilename } from "@/lib/filename"

// Every code point in an HTTP header value must be a WHATWG ByteString char (≤ 255). This asserts the
// whole header string a caller would set is safe to hand to `new Response(..., { headers })`.
function isHeaderByteSafe(value: string): boolean {
	for (const ch of value) {
		const cp = ch.codePointAt(0)

		if (cp === undefined || cp > 0xff) {
			return false
		}
	}

	return true
}

describe("sanitizeFilename", () => {
	it("strips control chars, quotes, slashes and CR/LF to underscores", () => {
		expect(sanitizeFilename('a"b\\c/d\r\ne')).toBe("a_b_c_d__e")
	})

	it("falls back to 'download' only for an empty name (stripped chars become underscores, not removed)", () => {
		expect(sanitizeFilename("")).toBe("download")
		expect(sanitizeFilename('/"\\')).toBe("___")
	})

	it("leaves plain ASCII untouched", () => {
		expect(sanitizeFilename("report.pdf")).toBe("report.pdf")
	})
})

describe("contentDispositionAttachment", () => {
	it("emits a bare quoted filename for a plain ASCII name (no filename* needed)", () => {
		expect(contentDispositionAttachment("e2e.zip")).toBe('attachment; filename="e2e.zip"')
	})

	it("keeps spaces inside the quoted ASCII fallback without a filename*", () => {
		expect(contentDispositionAttachment("my report.pdf")).toBe('attachment; filename="my report.pdf"')
	})

	// The headline bug: a CJK name above U+00FF made `new Response` throw synchronously. The old
	// `attachment; filename="文档.pdf"` was NOT a legal ByteString.
	it("percent-encodes a CJK name into a byte-safe filename* with an ASCII fallback", () => {
		const header = contentDispositionAttachment("文档.pdf")

		expect(header).toBe(`attachment; filename="__.pdf"; filename*=UTF-8''%E6%96%87%E6%A1%A3.pdf`)
		expect(isHeaderByteSafe(header)).toBe(true)
	})

	it("encodes Cyrillic names byte-safely", () => {
		const header = contentDispositionAttachment("Отчёт.txt")

		expect(header).toBe(`attachment; filename="_____.txt"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.txt`)
		expect(isHeaderByteSafe(header)).toBe(true)
	})

	it("encodes a multi-byte emoji (surrogate pair) byte-safely", () => {
		const header = contentDispositionAttachment("😀.png")

		expect(header).toBe(`attachment; filename="__.png"; filename*=UTF-8''%F0%9F%98%80.png`)
		expect(isHeaderByteSafe(header)).toBe(true)
	})

	it("folds only the non-ASCII portion of a mixed name, keeping ASCII verbatim in both forms", () => {
		const header = contentDispositionAttachment("mix-文-a.pdf")

		expect(header).toBe(`attachment; filename="mix-_-a.pdf"; filename*=UTF-8''mix-%E6%96%87-a.pdf`)
	})

	// RFC 5987 attr-char set differs from encodeURIComponent's unreserved set: `* ' ( )` are NOT
	// attr-chars and MUST be percent-encoded even though encodeURIComponent leaves them. They ARE
	// printable ASCII, so they survive verbatim in the plain quoted fallback.
	it("percent-encodes RFC 5987 non-attr-chars that encodeURIComponent would leave unescaped", () => {
		const header = contentDispositionAttachment("!*'()文")

		expect(header).toBe(`attachment; filename="!*'()_"; filename*=UTF-8''!%2A%27%28%29%E6%96%87`)
	})

	// The other half: `# $ & + ^ | \` ~ !` ARE attr-chars and must survive verbatim in filename*, even
	// though encodeURIComponent would percent-escape most of them.
	it("keeps RFC 5987 attr-char punctuation verbatim in filename*", () => {
		const header = contentDispositionAttachment("#$&+^|`~!文")

		expect(header).toBe(`attachment; filename="#$&+^|\`~!_"; filename*=UTF-8''#$&+^|\`~!%E6%96%87`)
	})

	// A quote/backslash/slash is stripped by the shared sanitize BEFORE encoding, so it can never break
	// the quoted value nor reach the filename* value literally.
	it("never lets a quote survive into either form", () => {
		const header = contentDispositionAttachment('a"b文')

		expect(header).toBe(`attachment; filename="a_b_"; filename*=UTF-8''a_b%E6%96%87`)
		expect(header).not.toContain('"b')
	})

	it("strips control chars before encoding", () => {
		const header = contentDispositionAttachment("a\x01\x02文")

		expect(header).toBe(`attachment; filename="a___"; filename*=UTF-8''a__%E6%96%87`)
		expect(isHeaderByteSafe(header)).toBe(true)
	})

	it("falls back to 'download' when the name is empty", () => {
		expect(contentDispositionAttachment("")).toBe('attachment; filename="download"')
	})
})

// Reproduces the actual crash site the SW hit: `new Response(body, { headers })` runs a WHATWG
// ByteString validation on every header value and throws synchronously on any code point > 255. That
// synchronous throw is what both broke the download AND leaked activeStreams (the increment ran before
// the throw, so its decrement never did, permanently gating SKIP_WAITING). The header build now
// happens before the counter is touched, and the value is always byte-safe — so this construction can
// never throw for a non-Latin-1 name.
describe("Content-Disposition header is a legal ByteString at the Response boundary", () => {
	it("the raw (unencoded) form still throws — proving the reproduction is real", () => {
		expect(() => new Response(null, { headers: { "Content-Disposition": `attachment; filename="文档.pdf"` } })).toThrow(TypeError)
	})

	for (const name of ["文档.pdf", "Отчёт.txt", "😀.png", "mix-文-a.pdf"]) {
		it(`constructs a Response without throwing for ${name}`, () => {
			expect(() => new Response(null, { headers: { "Content-Disposition": contentDispositionAttachment(name) } })).not.toThrow()
		})
	}
})
