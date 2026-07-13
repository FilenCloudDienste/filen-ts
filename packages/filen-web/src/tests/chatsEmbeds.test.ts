import { Buffer } from "buffer"
import { describe, expect, it } from "vitest"
import {
	parseFilenPublicLink,
	mediaCategoryFromUrl,
	isEmbeddableHttpsUrl,
	classifyEmbedUrl,
	embedCandidatesForLinks,
	extractMessageLinks,
	contentTypeMatchesCategory,
	MAX_MESSAGE_EMBEDS
} from "@/features/chats/lib/embeds.logic"

const UUID = "11111111-1111-1111-1111-111111111111"
const KEY_PLAINTEXT = "the-file-key"
const KEY_HEX = Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")

function fileLinkUrl(separator: "#" | "%23" = "%23"): string {
	return `https://app.filen.io/#/d/${UUID}${separator}${KEY_HEX}`
}

function dirLinkUrl(separator: "#" | "%23" = "%23"): string {
	return `https://app.filen.io/#/f/${UUID}${separator}${KEY_HEX}`
}

// NEW path-based format the app now BUILDS: /f/ = file, /d/ = directory (swapped from legacy), key in
// a literal-# fragment.
function newFileLinkUrl(): string {
	return `https://app.filen.io/f/${UUID}#${KEY_HEX}`
}

function newDirLinkUrl(): string {
	return `https://app.filen.io/d/${UUID}#${KEY_HEX}`
}

describe("parseFilenPublicLink", () => {
	it("parses the NEW path format for a file (/f/ = file)", () => {
		expect(parseFilenPublicLink(newFileLinkUrl())).toEqual({ kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT })
	})

	it("parses the NEW path format for a directory (/d/ = directory)", () => {
		expect(parseFilenPublicLink(newDirLinkUrl())).toEqual({ kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT })
	})

	it("still parses a LEGACY file link built with the old %23-encoded separator (backwards compat, /d/ = file)", () => {
		expect(parseFilenPublicLink(fileLinkUrl("%23"))).toEqual({ kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT })
	})

	it("still parses a LEGACY directory link the same way (/f/ = directory)", () => {
		expect(parseFilenPublicLink(dirLinkUrl("%23"))).toEqual({ kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT })
	})

	it("also accepts a legacy literal '#' separator (leniency, mirrors the mobile parser)", () => {
		expect(parseFilenPublicLink(fileLinkUrl("#"))).toEqual({ kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT })
	})

	it("accepts the legacy drive.filen.io host as well as app.filen.io", () => {
		expect(parseFilenPublicLink(`https://drive.filen.io/#/d/${UUID}%23${KEY_HEX}`)).toEqual({
			kind: "file",
			linkUuid: UUID,
			key: KEY_PLAINTEXT
		})
	})

	it("rejects a non-Filen host even with an otherwise-identical path shape", () => {
		expect(parseFilenPublicLink(`https://evil.example.com/#/d/${UUID}%23${KEY_HEX}`)).toBeNull()
	})

	it("rejects a Filen host with a different route (not /d/ or /f/)", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/x/${UUID}%23${KEY_HEX}`)).toBeNull()
	})

	it("rejects a link missing the key separator entirely", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}`)).toBeNull()
	})

	it("rejects a non-hex key (can't be decoded back to plaintext)", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23not-hex!!`)).toBeNull()
	})

	it("rejects an odd-length hex key", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23abc`)).toBeNull()
	})

	it("rejects a plain non-Filen url outright", () => {
		expect(parseFilenPublicLink("https://example.com/photo.png")).toBeNull()
	})
})

describe("mediaCategoryFromUrl", () => {
	it("classifies common image extensions", () => {
		expect(mediaCategoryFromUrl("https://example.com/a/photo.jpg")).toBe("image")
		expect(mediaCategoryFromUrl("https://example.com/photo.PNG")).toBe("image")
	})

	it("classifies common video extensions", () => {
		expect(mediaCategoryFromUrl("https://example.com/clip.mp4")).toBe("video")
	})

	it("returns null for HEIC/HEIF — no browser decodes them inline (needsImageTransform's rule, name-only)", () => {
		expect(mediaCategoryFromUrl("https://example.com/photo.heic")).toBeNull()
	})

	it("returns null for an unrelated extension (pdf, audio, no extension)", () => {
		expect(mediaCategoryFromUrl("https://example.com/doc.pdf")).toBeNull()
		expect(mediaCategoryFromUrl("https://example.com/track.mp3")).toBeNull()
		expect(mediaCategoryFromUrl("https://example.com/no-extension")).toBeNull()
	})

	it("returns null for an unparseable url", () => {
		expect(mediaCategoryFromUrl("not a url")).toBeNull()
	})
})

describe("isEmbeddableHttpsUrl", () => {
	it("accepts a plain https url", () => {
		expect(isEmbeddableHttpsUrl("https://example.com/a.png")).toBe(true)
	})

	it("rejects http (non-https)", () => {
		expect(isEmbeddableHttpsUrl("http://example.com/a.png")).toBe(false)
	})

	it("rejects a url carrying embedded credentials", () => {
		expect(isEmbeddableHttpsUrl("https://user:pass@example.com/a.png")).toBe(false)
	})

	it("rejects an unparseable string", () => {
		expect(isEmbeddableHttpsUrl("not a url")).toBe(false)
	})
})

describe("classifyEmbedUrl", () => {
	it("classifies a Filen file link as filenLink", () => {
		const url = fileLinkUrl()
		expect(classifyEmbedUrl(url)).toEqual({ kind: "filenLink", url, link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT } })
	})

	it("classifies a direct https image url as media", () => {
		const url = "https://example.com/photo.jpg"
		expect(classifyEmbedUrl(url)).toEqual({ kind: "media", url, category: "image" })
	})

	it("classifies a direct https video url as media", () => {
		const url = "https://example.com/clip.mp4"
		expect(classifyEmbedUrl(url)).toEqual({ kind: "media", url, category: "video" })
	})

	it("a YouTube link classifies as none (no YT/X/OG embeds are built)", () => {
		expect(classifyEmbedUrl("https://youtube.com/watch?v=abc123")).toEqual({
			kind: "none",
			url: "https://youtube.com/watch?v=abc123"
		})
	})

	it("a plain non-media https link classifies as none", () => {
		expect(classifyEmbedUrl("https://example.com/page")).toEqual({ kind: "none", url: "https://example.com/page" })
	})

	it("an http (non-https) media-shaped url classifies as none — https-only gate wins before extension", () => {
		expect(classifyEmbedUrl("http://example.com/photo.jpg")).toEqual({ kind: "none", url: "http://example.com/photo.jpg" })
	})
})

describe("embedCandidatesForLinks", () => {
	it("dedupes a repeated url, keeping first occurrence order", () => {
		const url = "https://example.com/photo.jpg"
		const candidates = embedCandidatesForLinks([url, url, url])

		expect(candidates).toHaveLength(1)
	})

	it("drops out-of-scope urls entirely (no 'none' entries ever reach the caller)", () => {
		expect(embedCandidatesForLinks(["https://example.com/page", "https://youtube.com/watch?v=x"])).toEqual([])
	})

	it("caps at MAX_MESSAGE_EMBEDS, oldest/first-seen wins", () => {
		const urls = Array.from({ length: MAX_MESSAGE_EMBEDS + 4 }, (_, i) => `https://example.com/${String(i)}.jpg`)

		const candidates = embedCandidatesForLinks(urls)

		expect(candidates).toHaveLength(MAX_MESSAGE_EMBEDS)
		expect(candidates[0]).toMatchObject({ url: "https://example.com/0.jpg" })
	})

	it("mixes filenLink and media candidates from the same message", () => {
		const fileUrl = fileLinkUrl()
		const imageUrl = "https://example.com/photo.jpg"

		const candidates = embedCandidatesForLinks([fileUrl, imageUrl])

		expect(candidates.map(c => c.kind)).toEqual(["filenLink", "media"])
	})
})

describe("extractMessageLinks", () => {
	it("pulls every 'link' segment's href, in order, from the regexed.logic pipeline", () => {
		// hardenLinkHref normalizes via `new URL().href`, which appends the root path — matches
		// segmentMessage's own actual output, not the raw substring the message text contained.
		expect(extractMessageLinks("see https://a.example.com and https://b.example.com too")).toEqual([
			"https://a.example.com/",
			"https://b.example.com/"
		])
	})

	it("returns [] for undefined/empty text", () => {
		expect(extractMessageLinks(undefined)).toEqual([])
		expect(extractMessageLinks("")).toEqual([])
	})

	it("never extracts a url embedded inside a code fence (regexed.logic's own ordering)", () => {
		expect(extractMessageLinks("```https://inside-code.example.com```")).toEqual([])
	})
})

describe("contentTypeMatchesCategory", () => {
	it("accepts an image/* content-type for the image category", () => {
		expect(contentTypeMatchesCategory("image/jpeg", "image")).toBe(true)
	})

	it("accepts a video/* content-type for the video category", () => {
		expect(contentTypeMatchesCategory("video/mp4", "video")).toBe(true)
	})

	it("rejects a mismatched category (a .mp4-shaped url actually serving an image)", () => {
		expect(contentTypeMatchesCategory("image/jpeg", "video")).toBe(false)
	})

	it("rejects a content-type outside the shared inline allowlist entirely (e.g. text/html — an error page)", () => {
		expect(contentTypeMatchesCategory("text/html", "image")).toBe(false)
	})

	it("rejects svg+xml for a video category and accepts it for image (allowlist is exact, not a broad image/* match)", () => {
		expect(contentTypeMatchesCategory("image/svg+xml", "image")).toBe(true)
		expect(contentTypeMatchesCategory("image/svg+xml", "video")).toBe(false)
	})
})
