// Link hardening for the message-text display pipeline (chat message segmentation itself lives in
// @filen/shared's chatMessageSegments — segmentMessage/isEmojiOnly, see there). A "link" segment
// carries the raw matched string, not a validated URL, so every call site that wants to render one as
// a clickable link must harden it here first.
//
// Defense-in-depth: only ever hand a link segment an http(s) href. A non-parseable or non-http(s) URL
// (javascript:, data:, mailto:, etc.) returns null so the caller renders it as inert text, never an
// anchor — chatMessageSegments's URL alternative already restricts to http(s), this closes the gap for
// anything that slips through (e.g. a trailing-punctuation edge) and gives tests a single hardening seam
// to assert.
export function hardenLinkHref(raw: string): string | null {
	let parsed: URL

	try {
		parsed = new URL(raw)
	} catch {
		return null
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null
	}

	return parsed.href
}
