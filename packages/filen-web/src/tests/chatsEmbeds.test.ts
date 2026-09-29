import { Buffer } from "buffer"
import { describe, expect, it } from "vitest"
import { segmentMessage } from "@filen/shared"
import { embedCandidatesForLinks, linksFromSegments, MAX_MESSAGE_EMBEDS } from "@/features/chats/lib/embeds.logic"

// Version 4 (third group starts "4"), variant 8 (fourth "8") — @filen/shared's parseFilenPublicLink
// validates both nibbles via the 'uuid' package, unlike a plain 8-4-4-4-12 hex-shape regex.
const UUID = "11111111-1111-4111-8111-111111111111"
// A realistic 32-byte key — @filen/shared's parseFilenPublicLink hard-rejects any other length.
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const KEY_HEX = Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")

// LEGACY hash-router file link (/d/ = file in that era).
function fileLinkUrl(): string {
	return `https://app.filen.io/#/d/${UUID}%23${KEY_HEX}`
}

// NEW path-based format the app now BUILDS: /f/ = file, /d/ = directory (swapped from legacy), key in
// a literal-# fragment.
function newFileLinkUrl(): string {
	return `https://app.filen.io/f/${UUID}#${KEY_HEX}`
}

function newDirLinkUrl(): string {
	return `https://app.filen.io/d/${UUID}#${KEY_HEX}`
}

describe("embedCandidatesForLinks", () => {
	it("yields a filenLink candidate for a Filen public link", () => {
		const url = fileLinkUrl()

		expect(embedCandidatesForLinks([url])).toEqual([{ kind: "filenLink", url, link: { type: "file", uuid: UUID, key: KEY_PLAINTEXT } }])
	})

	// Rendering one would make every reader's browser fetch from a host the sender picked.
	it("yields no embed for a remote image or video url", () => {
		expect(
			embedCandidatesForLinks([
				"https://example.com/photo.jpg",
				"https://example.com/photo.PNG",
				"https://example.com/clip.mp4",
				"http://example.com/photo.jpg"
			])
		).toEqual([])
	})

	it("yields no embed for any other non-Filen link (no YouTube/X/OpenGraph embeds)", () => {
		expect(embedCandidatesForLinks(["https://example.com/page", "https://youtube.com/watch?v=x"])).toEqual([])
	})

	it("keeps the Filen link and drops a remote image url from the same message", () => {
		const fileUrl = fileLinkUrl()

		expect(embedCandidatesForLinks(["https://example.com/photo.jpg", fileUrl]).map(c => c.url)).toEqual([fileUrl])
	})

	it("dedupes a repeated url, keeping first occurrence order", () => {
		const url = newDirLinkUrl()

		expect(embedCandidatesForLinks([url, url, url])).toHaveLength(1)
	})

	it("caps at MAX_MESSAGE_EMBEDS, oldest/first-seen wins", () => {
		const urls = Array.from(
			{ length: MAX_MESSAGE_EMBEDS + 4 },
			(_, i) => `https://app.filen.io/f/11111111-1111-4111-8111-${i.toString(16).padStart(12, "0")}#${KEY_HEX}`
		)

		const candidates = embedCandidatesForLinks(urls)

		expect(candidates).toHaveLength(MAX_MESSAGE_EMBEDS)
		expect(candidates[0]).toMatchObject({ url: urls[0] })
	})
})

function extractLinks(text: string | undefined): string[] {
	return linksFromSegments(segmentMessage(text))
}

describe("linksFromSegments", () => {
	it("pulls every 'link' segment's href, in order, from the shared segmentMessage pipeline", () => {
		// hardenLinkHref normalizes via `new URL().href`, which appends the root path — matches
		// segmentMessage's own actual output, not the raw substring the message text contained.
		expect(extractLinks("see https://a.example.com and https://b.example.com too")).toEqual([
			"https://a.example.com/",
			"https://b.example.com/"
		])
	})

	it("returns [] for undefined/empty text", () => {
		expect(extractLinks(undefined)).toEqual([])
		expect(extractLinks("")).toEqual([])
	})

	it("never extracts a url embedded inside a code fence (regexed.logic's own ordering)", () => {
		expect(extractLinks("```https://inside-code.example.com```")).toEqual([])
	})

	// A closing quote kept in the href lands in the key fragment, and the public link no longer parses.
	it("leaves a closing quote or angle bracket out of the href, so a quoted public link keeps its card", () => {
		const url = newFileLinkUrl()

		expect(extractLinks(`see "${url}" and <https://example.com/a.png>`)).toEqual([url, "https://example.com/a.png"])
		expect(embedCandidatesForLinks(extractLinks(`see "${url}" now`))).toEqual([
			{ kind: "filenLink", url, link: { type: "file", uuid: UUID, key: KEY_PLAINTEXT } }
		])
	})
})
