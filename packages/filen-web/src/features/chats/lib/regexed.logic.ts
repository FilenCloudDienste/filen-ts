// Message-text display pipeline — PURE, no React, unit-tested against the segment output.
//
// This is NOT a markdown renderer. It is the same fixed, combined-regex transform mobile ships
// (`filen-mobile/.../message/regexed.tsx`) and old-web ships (`regexifyString`): a single left-to-right
// pass over the raw plaintext that splits it into typed segments. The alternation ORDER is load-bearing
// (mobile: emoji | code | url | mention | linebreak) — whichever alternative matches earliest at a scan
// position wins, so code fences swallow any URL/mention inside them, and so on. We reproduce that order
// exactly rather than pull in `regexify-string` (absent here) so the ordering stays explicit and testable.
//
// INJECTION SAFETY: every segment is plain data (strings), rendered downstream into React text nodes /
// elements only — never `dangerouslySetInnerHTML`, never parsed HTML. Injection is structurally
// impossible on this path, so — unlike notes' rich-HTML read path — NO DOMPurify is needed.
// Link hardening below is defense-in-depth for the anchor a link segment becomes, not sanitization.

// @<local>@<domain>.<tld> or the literal @everyone. Mirrors mobile's MENTION_REGEX exactly.
const MENTION_SOURCE = "@[\\w.-]+@[\\w.-]+\\.\\w+|@everyone"
// Triple-backtick fenced block, non-greedy across newlines.
const CODE_SOURCE = "```[\\s\\S]*?```"
// Bare http(s) URL. Old-web/mobile only auto-link http(s); other schemes stay plain text (and are
// rejected again by hardenLinkHref below as defense-in-depth).
const URL_SOURCE = "https?://[^\\s]+"
// :shortcode: (optionally ::skin-tone-N:). Detected so the ordering slot exists and jumbo-emoji sizing
// can be computed; resolved to a standard unicode glyph via emoji.ts's lookup table — an unknown
// shortcode (a custom-pack name from a mobile/old-web peer) stays literal text (see messageContent.tsx).
const EMOJI_SOURCE = ":[\\d+_a-z-]+(?:::skin-tone-\\d+)?:"
const LINE_BREAK_SOURCE = "\\n"

// Order — emoji | code | url | mention | linebreak — matches mobile's combined REGEX. `g` so we can walk
// every match; the alternation gives priority when two could start at the same index.
const COMBINED = new RegExp(`${EMOJI_SOURCE}|${CODE_SOURCE}|${URL_SOURCE}|${MENTION_SOURCE}|${LINE_BREAK_SOURCE}`, "g")

export type MessageSegment =
	| { kind: "text"; value: string }
	| { kind: "linebreak" }
	| { kind: "code"; code: string }
	| { kind: "link"; href: string }
	| { kind: "mention"; everyone: boolean; email: string | null }
	| { kind: "emoji"; shortcode: string }

// Strips the ``` fences + surrounding blank lines from a code match, mirroring mobile's CodeBlock trim.
function extractCode(match: string): string {
	let code = match.split("```").join("").trim()

	while (code.startsWith("\n")) {
		code = code.slice(1)
	}

	while (code.endsWith("\n")) {
		code = code.slice(0, -1)
	}

	return code
}

// Defense-in-depth: only ever hand a link segment an http(s) href. A non-parseable or non-http(s) URL
// (javascript:, data:, mailto:, etc.) is returned null so the caller renders it as inert text, never an
// anchor — the URL_SOURCE regex already restricts to http(s), this closes the gap for anything that slips
// through (e.g. a trailing-punctuation edge) and gives tests a single hardening seam to assert.
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

function classify(match: string): MessageSegment {
	// Mention — @everyone or @<email>. The alternation can only hand us one of these two forms.
	if (match === "@everyone") {
		return { kind: "mention", everyone: true, email: null }
	}

	if (match.startsWith("@")) {
		const email = match.slice(1).trim()

		return { kind: "mention", everyone: false, email: email.includes("@") ? email : null }
	}

	// Code fence.
	if (match.startsWith("```")) {
		return { kind: "code", code: extractCode(match) }
	}

	// URL — hardened; a rejected href falls back to text so a poisoned scheme never becomes an anchor.
	if (match.startsWith("http")) {
		const href = hardenLinkHref(match)

		return href !== null ? { kind: "link", href } : { kind: "text", value: match }
	}

	if (match === "\n") {
		return { kind: "linebreak" }
	}

	// Emoji shortcode (the only remaining alternative).
	return { kind: "emoji", shortcode: match.split(":").join("").trim() }
}

// Splits raw message text into ordered typed segments, interleaving the plain-text runs between matches.
// Returns [] for empty/undecryptable text (caller renders the undecryptable placeholder instead).
export function segmentMessage(text: string | undefined): MessageSegment[] {
	if (text === undefined || text.length === 0) {
		return []
	}

	const segments: MessageSegment[] = []
	let lastIndex = 0
	// Fresh lastIndex per call — COMBINED is module-level + global, so it must be reset each walk.
	COMBINED.lastIndex = 0

	let match = COMBINED.exec(text)

	while (match !== null) {
		if (match.index > lastIndex) {
			segments.push({ kind: "text", value: text.slice(lastIndex, match.index) })
		}

		segments.push(classify(match[0]))
		lastIndex = match.index + match[0].length

		// Zero-length guard: no alternative can match empty, but keep the loop total-safe.
		if (match[0].length === 0) {
			COMBINED.lastIndex += 1
		}

		match = COMBINED.exec(text)
	}

	if (lastIndex < text.length) {
		segments.push({ kind: "text", value: text.slice(lastIndex) })
	}

	return segments
}

// A message is "emoji-only" (jumbo sizing candidate) when it contains at least one emoji shortcode and,
// once every shortcode is removed, only whitespace remains — mirrors mobile's emojiSize heuristic. The
// jumbo IMAGE render itself is not wired to any component yet (it needs the shared custom-emoji pack,
// which this web build does not ship — see emoji.ts); this predicate is exported now so
// the sizing decision has a tested home.
export function isEmojiOnly(text: string | undefined): boolean {
	if (text === undefined || text.length === 0) {
		return false
	}

	const emojiMatches = text.match(new RegExp(EMOJI_SOURCE, "gi"))

	if (!emojiMatches) {
		return false
	}

	return emojiMatches.join("").length === text.trim().length
}
