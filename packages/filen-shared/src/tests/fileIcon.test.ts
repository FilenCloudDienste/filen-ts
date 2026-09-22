import { describe, expect, it } from "vitest"
import { fileIconKey, type FileIconSets } from "@filen/shared"

// Plain predicate stubs — no import of either app's real image/video/audio extension sets, per the
// batch's settled test scope: this exercises fileIconKey's own routing, not either app's coverage.
const STUB_IMAGE_EXTENSIONS = new Set(["png", "svg", "heic", "nef"])
const STUB_VIDEO_EXTENSIONS = new Set(["mp4"])
const STUB_AUDIO_EXTENSIONS = new Set(["mp3"])

const stubSets: FileIconSets = {
	isImage: ext => STUB_IMAGE_EXTENSIONS.has(ext),
	isVideo: ext => STUB_VIDEO_EXTENSIONS.has(ext),
	isAudio: ext => STUB_AUDIO_EXTENSIONS.has(ext)
}

describe("fileIconKey", () => {
	it("routes image/video/audio through the injected sets", () => {
		expect(fileIconKey("png", stubSets)).toBe("image")
		expect(fileIconKey("svg", stubSets)).toBe("image")
		expect(fileIconKey("heic", stubSets)).toBe("image")
		// Camera RAW shares the plain image glyph on purpose: FileIconKey is an exhaustive union keyed
		// to concrete SVG assets, so a distinct "raw" key would mean shipping a new one.
		expect(fileIconKey("nef", stubSets)).toBe("image")
		expect(fileIconKey("mp4", stubSets)).toBe("video")
		expect(fileIconKey("mp3", stubSets)).toBe("audio")
	})

	it("checks image/video/audio before any fixed extension branch", () => {
		// "pdf" is normally the pdf branch — an injected set can still claim it as image/video/audio,
		// proving the injected sets are consulted first.
		expect(fileIconKey("pdf", { isImage: () => true, isVideo: () => false, isAudio: () => false })).toBe("image")
	})

	it("routes document and office types", () => {
		expect(fileIconKey("pdf", stubSets)).toBe("pdf")
		expect(fileIconKey("txt", stubSets)).toBe("txt")
		expect(fileIconKey("doc", stubSets)).toBe("doc")
		expect(fileIconKey("docx", stubSets)).toBe("doc")
		expect(fileIconKey("pptx", stubSets)).toBe("ppt")
		expect(fileIconKey("xlsx", stubSets)).toBe("xls")
	})

	it("routes archives, code, binaries and platform packages", () => {
		expect(fileIconKey("zip", stubSets)).toBe("archive")
		expect(fileIconKey("rs", stubSets)).toBe("code")
		expect(fileIconKey("md", stubSets)).toBe("code")
		expect(fileIconKey("log", stubSets)).toBe("code")
		// .ahk is settled as code for the icon classifier only — see fileIcon.ts's own comment.
		expect(fileIconKey("ahk", stubSets)).toBe("code")
		expect(fileIconKey("exe", stubSets)).toBe("exe")
		expect(fileIconKey("apk", stubSets)).toBe("android")
		expect(fileIconKey("ipa", stubSets)).toBe("apple")
		expect(fileIconKey("iso", stubSets)).toBe("iso")
		expect(fileIconKey("dmg", stubSets)).toBe("iso")
		expect(fileIconKey("cad", stubSets)).toBe("cad")
		expect(fileIconKey("psd", stubSets)).toBe("psd")
	})

	// The ninth extension the B39 move changes on mobile: CODE_FILE_EXTENSIONS excludes "markdown" (each
	// app used to compose it back in independently, and mobile's inline switch never did), but this
	// classifier's own CODE_EXTENSIONS includes it directly.
	it("routes markdown as code", () => {
		expect(fileIconKey("markdown", stubSets)).toBe("code")
	})

	it("falls back to other for an unrecognised or empty extension", () => {
		expect(fileIconKey("xyz", stubSets)).toBe("other")
		expect(fileIconKey("", stubSets)).toBe("other")
	})
})
