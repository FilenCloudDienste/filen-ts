// Shared by the service worker's Content-Disposition path (sw/sw.ts) and any client-side file name
// construction that saves attacker-influenced text to disk (notes export) — one sanitize rule for
// "safe to use as a downloaded file's name", never duplicated. Strips anything that could break a
// quoted header value or a real filesystem path (control chars, quote, backslash, forward slash,
// CR/LF); RFC 5987 non-ASCII `filename*` encoding is a separate, still-unaddressed refinement.
export function sanitizeFilename(name: string): string {
	// eslint-disable-next-line no-control-regex -- deliberately stripping control chars from a filename
	return name.replace(/[\x00-\x1f"\\/\r\n]/g, "_") || "download"
}
