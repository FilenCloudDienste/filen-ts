import { describe, expect, it } from "vitest"
import { hardenLinkHref } from "@/features/chats/lib/regexed.logic"

// segmentMessage/isEmojiOnly moved to @filen/shared's chatMessageSegments (tested there). This file
// covers web's own hardenLinkHref — link-scheme policy stays app-owned, not shared.

describe("hardenLinkHref", () => {
	it("accepts http and https and returns the normalized href", () => {
		expect(hardenLinkHref("https://example.com")).toBe("https://example.com/")
		expect(hardenLinkHref("http://example.com/a")).toBe("http://example.com/a")
	})

	it("rejects non-http(s) schemes (javascript:, data:, ftp:, mailto:) → null", () => {
		expect(hardenLinkHref("javascript:alert(1)")).toBeNull()
		expect(hardenLinkHref("data:text/html,<script>1</script>")).toBeNull()
		expect(hardenLinkHref("ftp://host/file")).toBeNull()
		expect(hardenLinkHref("mailto:a@b.com")).toBeNull()
	})

	it("rejects unparseable input → null", () => {
		expect(hardenLinkHref("not a url")).toBeNull()
	})
})
