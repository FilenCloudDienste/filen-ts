// One shared segmenter: contactInitials runs once per avatar row.
const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null

// First grapheme of the display name, uppercased — the avatar fallback when no image loads. A whole grapheme,
// not one UTF-16 unit, so emoji, flags and astral characters are not cut in half. "?" only covers the
// type-level empty-string case (email is never empty in practice).
export function contactInitials(displayName: string): string {
	const trimmed = displayName.trim()
	const codePoint = trimmed.codePointAt(0)

	if (codePoint === undefined) {
		return "?"
	}

	const first = graphemeSegmenter?.segment(trimmed).containing(0)?.segment ?? String.fromCodePoint(codePoint)

	return first.toUpperCase()
}
