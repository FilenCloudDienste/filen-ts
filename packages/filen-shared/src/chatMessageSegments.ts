// Message-text segmentation — splits raw chat-message text into an ordered sequence of typed
// segments via one left-to-right pass over a fixed, priority-ordered alternation (emoji | code | url |
// mention | linebreak). The alternation ORDER is load-bearing: whichever alternative matches earliest
// at a scan position wins, so a code fence swallows any url/mention inside it, and so on.
//
// Segments are DATA ONLY. A "link" segment carries the raw matched string, not a validated URL — link
// scheme/host policy (which schemes are trusted, private-host guards, domain-trust prompts) and mention
// label resolution (participant lookup, i18n) are each app's own concern, applied at the render layer.

// @<local>@<domain>.<tld> or the literal @everyone.
const MENTION_SOURCE = "@[\\w.-]+@[\\w.-]+\\.\\w+|@everyone"
// Triple-backtick fenced block, non-greedy across newlines.
const CODE_SOURCE = "```[\\s\\S]*?```"
// Bare http(s) URL — only http(s) auto-links; other schemes stay plain text. It ends before `<>"` and the
// backtick, which a URL never holds unencoded, so a quoted or bracketed link leaves the closing character
// out. An apostrophe ends it in the host, and in the path when no letter or digit follows (a closing
// quote), so "Hitchhiker's_Guide" stays whole; any non-ASCII character counts as a letter. Ending it here
// rather than cutting the match afterwards keeps segmentation one linear pass.
const URL_SOURCE = "https?://[^\\s<>\"'`/?#]*(?:[/?#][^\\s<>\"'`]*(?:'(?=[\\dA-Za-z\\u0080-\\uffff])[^\\s<>\"'`]*)*)?"
// :shortcode: (optionally ::skin-tone-N:). Detected so the ordering slot exists and the emoji-only
// heuristic below can be computed; resolving a shortcode to a glyph or image is a render-layer concern.
const EMOJI_SOURCE = ":[\\d+_a-z-]+(?:::skin-tone-\\d+)?:"
const LINE_BREAK_SOURCE = "\\n"

// Order — emoji | code | url | mention | linebreak. `g` so every match can be walked; the alternation
// gives priority when two alternatives could start at the same index.
const COMBINED = new RegExp(`${EMOJI_SOURCE}|${CODE_SOURCE}|${URL_SOURCE}|${MENTION_SOURCE}|${LINE_BREAK_SOURCE}`, "g")

export type MessageSegment =
	| { kind: "text"; value: string }
	| { kind: "linebreak" }
	| { kind: "code"; code: string }
	| { kind: "link"; raw: string }
	| { kind: "mention"; everyone: boolean; email: string | null }
	// `raw` is the matched text: an unresolved shortcode renders it as sent, since `shortcode` drops
	// every colon (":thumbsup::skin-tone-2:" is "thumbsupskin-tone-2").
	| { kind: "emoji"; shortcode: string; raw: string }

// Strips the ``` fences and surrounding blank lines from a code match.
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

	// URL — raw and unvalidated; the caller applies its own link policy before treating this as a
	// clickable link.
	if (match.startsWith("http")) {
		return { kind: "link", raw: match }
	}

	if (match === "\n") {
		return { kind: "linebreak" }
	}

	// Emoji shortcode (the only remaining alternative).
	return { kind: "emoji", shortcode: match.split(":").join("").trim(), raw: match }
}

// Splits raw message text into ordered typed segments, interleaving the plain-text runs between
// matches. Returns [] for empty/undecryptable text (the caller renders its own undecryptable
// placeholder instead).
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

// A message is "emoji-only" (jumbo-sizing candidate) when it contains at least one emoji shortcode
// and, once every shortcode is removed, only whitespace remains.
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
