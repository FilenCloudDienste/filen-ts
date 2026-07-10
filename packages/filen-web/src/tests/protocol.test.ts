import { describe, expect, it } from "vitest"
import { isAllowedInlineContentType } from "@/lib/sw/protocol"

// SECURITY: this is the SW's own independent re-check (sw.ts's handleDownload) for what may render
// inline via the preview route — never trust the page's claim, never trust the file's own claimed
// mime. Table-tested exhaustively since a false positive here is a same-origin XSS primitive (an
// attacker-controlled file served with an inline text/html or unescaped-xml Content-Type).

describe("isAllowedInlineContentType — image allowlist (exact match only)", () => {
	it.each([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/svg+xml",
		"image/bmp",
		"image/x-icon",
		"image/apng",
		"image/avif"
	])("allows %s", mime => {
		expect(isAllowedInlineContentType(mime)).toBe(true)
	})

	it.each(["image/tiff", "image/heic", "image/heif", "image/vnd.adobe.photoshop", "image/svg"])(
		"rejects unlisted image type %s",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})

describe("isAllowedInlineContentType — video/audio (broad codec-agnostic pattern)", () => {
	it.each([
		"video/mp4",
		"video/webm",
		"video/ogg",
		"video/quicktime",
		"video/x-matroska",
		"audio/mpeg",
		"audio/wav",
		"audio/ogg",
		"audio/aac",
		"audio/x-flac",
		"audio/mp4"
	])("allows %s", mime => {
		expect(isAllowedInlineContentType(mime)).toBe(true)
	})

	it.each(["video/", "audio/", "video", "audio", "videos/mp4", "audio2/mp3", "video/mp4/extra", "video/mp 4"])(
		"rejects malformed video/audio subtype %s",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})

describe("isAllowedInlineContentType — svg/html/xml exclusion posture", () => {
	it("allows the exact allowlisted svg mime", () => {
		expect(isAllowedInlineContentType("image/svg+xml")).toBe(true)
	})

	it.each(["text/html", "application/xhtml+xml", "text/xml", "application/xml", "image/svg", "application/svg+xml"])(
		"rejects %s — never an inline HTML/XML render target",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})

describe("isAllowedInlineContentType — parameterized types (charset etc.) are never stripped, so they never match", () => {
	it.each(["video/mp4; charset=utf-8", "image/png;charset=utf-8", "image/svg+xml; charset=UTF-8", "audio/mpeg;codecs=opus"])(
		"rejects %s — no parameter-stripping, an exact string match only",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})

describe("isAllowedInlineContentType — case variance and whitespace are normalized", () => {
	it.each([
		["IMAGE/PNG", true],
		["Image/Png", true],
		["VIDEO/MP4", true],
		["AUDIO/OGG", true],
		["  image/png  ", true],
		["\timage/svg+xml\n", true],
		["TEXT/HTML", false]
	] as const)("normalizes %s -> %s", (mime, expected) => {
		expect(isAllowedInlineContentType(mime)).toBe(expected)
	})
})

describe("isAllowedInlineContentType — empty/garbage input", () => {
	it.each(["", " ", "garbage", "application/octet-stream", "text/plain", "font/woff2", "application/pdf", "image", "video/"])(
		"rejects %s",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})
