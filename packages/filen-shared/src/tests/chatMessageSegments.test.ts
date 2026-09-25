import { describe, expect, it } from "vitest"
import { segmentMessage, isEmojiOnly, type MessageSegment } from "@filen/shared"

// The segmentation pipeline is pure — assert the SEGMENT output directly (each app's render is a thin
// map over these). Link hardening and mention-label resolution are app-owned and tested there, not here.

function kinds(segments: MessageSegment[]): string[] {
	return segments.map(s => s.kind)
}

describe("segmentMessage", () => {
	it("returns [] for empty / undefined (undecryptable placeholder handled by the caller)", () => {
		expect(segmentMessage(undefined)).toEqual([])
		expect(segmentMessage("")).toEqual([])
	})

	it("keeps plain text as a single text segment", () => {
		expect(segmentMessage("just some words")).toEqual([{ kind: "text", value: "just some words" }])
	})

	it("detects an http(s) link and interleaves the surrounding text, carrying the raw matched string", () => {
		const segments = segmentMessage("see https://example.com/path now")

		expect(segments).toEqual([
			{ kind: "text", value: "see " },
			{ kind: "link", raw: "https://example.com/path" },
			{ kind: "text", value: " now" }
		])
	})

	it("renders a code fence as a code segment and does NOT linkify inside it (order: code before url)", () => {
		const segments = segmentMessage("```see https://x.com inside```")

		expect(segments).toEqual([{ kind: "code", code: "see https://x.com inside" }])
	})

	it("strips fences and surrounding blank lines from a code block", () => {
		const segments = segmentMessage("```\nconst x = 1\n```")

		expect(segments).toEqual([{ kind: "code", code: "const x = 1" }])
	})

	it("classifies @everyone and @email mentions", () => {
		expect(segmentMessage("@everyone hi")).toEqual([
			{ kind: "mention", everyone: true, email: null },
			{ kind: "text", value: " hi" }
		])

		expect(segmentMessage("hey @user@host.com")).toEqual([
			{ kind: "text", value: "hey " },
			{ kind: "mention", everyone: false, email: "user@host.com" }
		])
	})

	it("emits a linebreak segment for a newline", () => {
		expect(kinds(segmentMessage("a\nb"))).toEqual(["text", "linebreak", "text"])
	})

	it("detects an emoji shortcode segment (emoji has priority in the alternation order)", () => {
		expect(segmentMessage("hi :smile:")).toEqual([
			{ kind: "text", value: "hi " },
			{ kind: "emoji", shortcode: "smile", raw: ":smile:" }
		])
	})

	// The shortcode drops every colon, so an unresolved skin-tone form can only be shown as sent via raw.
	it("keeps a skin-tone shortcode's matched text as raw", () => {
		expect(segmentMessage("nice :thumbsup::skin-tone-2:")).toEqual([
			{ kind: "text", value: "nice " },
			{ kind: "emoji", shortcode: "thumbsupskin-tone-2", raw: ":thumbsup::skin-tone-2:" }
		])
	})
})

describe("segmentMessage — where a link ends", () => {
	// Both apps open a link segment's raw string, so a closing character left in it corrupts the URL.
	it.each([
		["\"https://example.com/path\"", "\"", "https://example.com/path", "\""],
		["'https://example.com'", "'", "https://example.com", "'"],
		["`https://example.com`", "`", "https://example.com", "`"],
		["<https://example.com/path>", "<", "https://example.com/path", ">"],
		["('https://example.com/path'),", "('", "https://example.com/path", "'),"]
	])("leaves the closing character of %s out of the link", (wrapped, before, url, after) => {
		expect(segmentMessage(`see ${wrapped} now`)).toEqual([
			{ kind: "text", value: `see ${before}` },
			{ kind: "link", raw: url },
			{ kind: "text", value: `${after} now` }
		])
	})

	it("keeps an apostrophe a letter or digit follows in the path, and ends the host at any apostrophe", () => {
		expect(segmentMessage("https://en.wikipedia.org/wiki/Hitchhiker's_Guide")).toEqual([
			{ kind: "link", raw: "https://en.wikipedia.org/wiki/Hitchhiker's_Guide" }
		])
		expect(segmentMessage("https://example.com/l'été")).toEqual([{ kind: "link", raw: "https://example.com/l'été" }])
		expect(segmentMessage("https://example.com's pricing")).toEqual([
			{ kind: "link", raw: "https://example.com" },
			{ kind: "text", value: "'s pricing" }
		])
	})

	it("keeps an apostrophe in the path that a Latin, Cyrillic, Hebrew or astral letter follows", () => {
		for (const path of ["d'Artagnan", "x'\u0416\u0443\u043a", "x'\u05d2\u05d9\u05e8", "x'\ud835\udc00"]) {
			expect(segmentMessage(`https://example.com/${path}`)).toEqual([{ kind: "link", raw: `https://example.com/${path}` }])
		}
	})

	// These scripts put no apostrophe inside a word, and often no space after a closing quote, so the apostrophe is one.
	it.each([
		["Japanese", "\u65e5\u672c"],
		["Korean", "\ud55c\uad6d"],
		["Chinese beyond the first plane", "\ud840\udc00"],
		["Thai", "\u0e44\u0e17\u0e22"],
		["halfwidth katakana", "\uff76\uff80"]
	])("ends the link at an apostrophe that %s follows", (_name, word) => {
		expect(segmentMessage(`https://example.com/x'${word}`)).toEqual([
			{ kind: "link", raw: "https://example.com/x" },
			{ kind: "text", value: `'${word}` }
		])
	})

	it.each([
		["\ub9c1\ud06c\ub294 'https://example.com/docs'\ub97c \ud655\uc778\ud558\uc138\uc694", "\ub9c1\ud06c\ub294 '", "https://example.com/docs", "'\ub97c \ud655\uc778\ud558\uc138\uc694"],
		["'https://example.com/docs'\u3092\u898b\u3066\u304f\u3060\u3055\u3044", "'", "https://example.com/docs", "'\u3092\u898b\u3066\u304f\u3060\u3055\u3044"],
		["'https://example.com/docs'\u91cc\u6709\u8bf4\u660e", "'", "https://example.com/docs", "'\u91cc\u6709\u8bf4\u660e"],
		["'https://example.com/docs'\u0e04\u0e23\u0e31\u0e1a", "'", "https://example.com/docs", "'\u0e04\u0e23\u0e31\u0e1a"],
		[
			`'https://app.filen.io/d/0b0d4b5e-7c0e-4d8e-9f2a-1a2b3c4d5e6f#${"ab".repeat(32)}'\ub97c \uc5f4\uc5b4\ubd10`,
			"'",
			`https://app.filen.io/d/0b0d4b5e-7c0e-4d8e-9f2a-1a2b3c4d5e6f#${"ab".repeat(32)}`,
			"'\ub97c \uc5f4\uc5b4\ubd10"
		]
	])("ends a quoted link the next word follows at its quote: %s", (message, before, url, after) => {
		expect(segmentMessage(message)).toEqual([
			{ kind: "text", value: before },
			{ kind: "link", raw: url },
			{ kind: "text", value: after }
		])
	})

	// These are non-ASCII, which the check for a letter after an apostrophe otherwise accepts.
	it.each([
		["a no-break space", "\u00a0"],
		["a narrow no-break space", "\u202f"],
		["an ideographic space", "\u3000"],
		["an emoji", "\ud83d\ude00"],
		["an emoji in the symbol blocks", "\u2705"],
		["an ideographic full stop", "\u3002"],
		["a fullwidth comma", "\uff0c"],
		["an ellipsis", "\u2026"],
		["an em dash", "\u2014"],
		["a closing double quote", "\u201d"],
		["a closing guillemet", "\u00bb"],
		["an Arabic question mark", "\u061f"],
		["a danda", "\u0964"]
	])("ends a quoted link before its closing quote when %s follows it", (_name, after) => {
		expect(segmentMessage(`see 'https://example.com/a'${after}now`)).toEqual([
			{ kind: "text", value: "see '" },
			{ kind: "link", raw: "https://example.com/a" },
			{ kind: "text", value: `'${after}now` }
		])
	})

	it("segments what follows a link's end in the same pass, a code fence across whitespace included", () => {
		expect(segmentMessage("[\"https://a.example.com\",\"https://b.example.com\"]:gigachad:")).toEqual([
			{ kind: "text", value: "[\"" },
			{ kind: "link", raw: "https://a.example.com" },
			{ kind: "text", value: "\",\"" },
			{ kind: "link", raw: "https://b.example.com" },
			{ kind: "text", value: "\"]" },
			{ kind: "emoji", shortcode: "gigachad", raw: ":gigachad:" }
		])
		expect(segmentMessage("\"https://example.com\"```a b```")).toEqual([
			{ kind: "text", value: "\"" },
			{ kind: "link", raw: "https://example.com" },
			{ kind: "text", value: "\"" },
			{ kind: "code", code: "a b" }
		])
	})

	it("ends every link of a message-length run with no spaces", () => {
		const segments = segmentMessage("http://a\"".repeat(7274))

		expect(segments).toHaveLength(14548)
		expect(segments.filter(segment => segment.kind === "link" && segment.raw === "http://a")).toHaveLength(7274)
	})
})

describe("isEmojiOnly", () => {
	it("is true only when the message is entirely emoji shortcodes (jumbo candidate)", () => {
		expect(isEmojiOnly(":smile:")).toBe(true)
		expect(isEmojiOnly(":smile::wave:")).toBe(true)
	})

	it("is false when any non-emoji text remains, or there is no emoji at all", () => {
		expect(isEmojiOnly(":smile: hi")).toBe(false)
		expect(isEmojiOnly("hello")).toBe(false)
		expect(isEmojiOnly("")).toBe(false)
		expect(isEmojiOnly(undefined)).toBe(false)
	})
})
