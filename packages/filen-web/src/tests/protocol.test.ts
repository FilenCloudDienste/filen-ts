import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
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

// Only the ENDS are trimmed, so anything smuggled into the middle of the value — the shape a header
// injection takes — can never normalize back onto the allowlist.
describe("isAllowedInlineContentType — interior whitespace is never normalized away", () => {
	it.each(["image/\npng", "image/ png", "image/png\r\nContent-Disposition: inline", "video/mp4\r\nX-Frame-Options: none"])(
		"rejects %s",
		mime => {
			expect(isAllowedInlineContentType(mime)).toBe(false)
		}
	)
})

// The predicate's load-bearing consumer is sw.ts's serve path, which cannot be imported here: it is a
// ServiceWorkerGlobalScope module that registers listeners and pulls the SW-hosted wasm SDK at import.
// So this is a source-level drift guard over that one decision — the shape of the check, and that the
// only inline Content-Type the SW ever emits sits behind it. A page-supplied contentType served inline
// without this re-validation is a same-origin XSS primitive.
describe("sw.ts inline-serve gate", () => {
	const source = readFileSync("src/sw/sw.ts", "utf8")
	const start = source.indexOf("function handleDownload(")
	const handleDownload = source.slice(start, source.indexOf("\n}", start))

	it("re-validates the registered contentType inside the download route", () => {
		expect(start).toBeGreaterThan(-1)
		expect(handleDownload).toMatch(/if\s*\(!isAllowedInlineContentType\(pending\.contentType\)\)/)
	})

	it("imports the predicate from the shared protocol contract rather than restating the allowlist", () => {
		expect(source).toMatch(/import\s*\{[^}]*isAllowedInlineContentType[^}]*\}\s*from\s*"@\/lib\/sw\/protocol"/s)
	})

	it("serves the claimed contentType inline only after that gate, and degrades to an attachment otherwise", () => {
		const gate = handleDownload.search(/if\s*\(!isAllowedInlineContentType\(pending\.contentType\)\)/)
		const inlineServe = handleDownload.indexOf("contentType: pending.contentType")

		expect(gate).toBeGreaterThan(-1)
		expect(inlineServe).toBeGreaterThan(gate)
		// The rejected arm falls back to the forced-attachment response a plain file download gets.
		expect(handleDownload.slice(gate, inlineServe)).toContain("attachmentHeaders(pending.name)")
	})
})
