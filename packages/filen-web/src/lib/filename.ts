// Shared by the service worker's Content-Disposition path (sw/sw.ts) and any client-side file name
// construction that saves attacker-influenced text to disk (notes export) — one sanitize rule for
// "safe to use as a downloaded file's name", never duplicated. Strips anything that could break a
// quoted header value or a real filesystem path (control chars, quote, backslash, forward slash,
// CR/LF).
export function sanitizeFilename(name: string): string {
	// eslint-disable-next-line no-control-regex -- deliberately stripping control chars from a filename
	return name.replace(/[\x00-\x1f"\\/\r\n]/g, "_") || "download"
}

// RFC 5987 attr-char set (the only bytes allowed unescaped in an ext-value): ALPHA / DIGIT and the
// literal punctuation `! # $ & + - . ^ _ \` | ~`. Everything else — including many characters that
// encodeURIComponent leaves untouched (`* ' ( )`) and characters encodeURIComponent needlessly escapes
// (`! ~`) — MUST be percent-encoded, so this is deliberately NOT encodeURIComponent.
const RFC5987_ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/

// Percent-encode a string as an RFC 5987 ext-value (used for the `filename*=UTF-8''…` form): UTF-8
// each code point to bytes, then keep attr-char bytes verbatim and percent-encode every other byte.
function encodeRfc5987(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let out = ""

	for (const byte of bytes) {
		const char = String.fromCharCode(byte)

		if (byte < 0x80 && RFC5987_ATTR_CHAR.test(char)) {
			out += char
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
		}
	}

	return out
}

// Build a byte-safe `Content-Disposition: attachment` header value for an arbitrary user filename.
// HTTP header values are WHATWG ByteStrings (every code point ≤ 255), so a raw `filename="文档.pdf"`
// makes `new Response(..., { headers })` throw — the returned string is always pure ASCII. The quoted
// `filename=` carries an ASCII-folded fallback for legacy clients; when the name has characters that
// fold can't represent, an RFC 6266 `filename*=UTF-8''…` carrying the exact percent-encoded name is
// appended for clients that support it (all current browsers), which then take precedence.
export function contentDispositionAttachment(name: string): string {
	const safe = sanitizeFilename(name)
	const asciiFallback = safe.replace(/[^\x20-\x7e]/g, "_")

	if (safe === asciiFallback) {
		return `attachment; filename="${asciiFallback}"`
	}

	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(safe)}`
}
