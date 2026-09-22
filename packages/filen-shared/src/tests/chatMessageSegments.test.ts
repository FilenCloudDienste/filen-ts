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
			{ kind: "emoji", shortcode: "smile" }
		])
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
