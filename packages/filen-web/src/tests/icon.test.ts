import { describe, expect, it } from "vitest"
import { directoryFolderTint, fileIconKey, shadeColor } from "@/features/drive/lib/icon.logic"

// Full extension-routing coverage lives in @filen/shared's fileIcon.test.ts now — fileIconKey here is
// a thin wrapper (icon.logic.ts) deriving `ext` via extensionOf and delegating to the shared
// classifier, so this only proves the wrapper still resolves a NAME to the right key.
describe("fileIconKey", () => {
	it("routes image/video/audio by extension (case-insensitive)", () => {
		expect(fileIconKey("photo.PNG")).toBe("image")
		expect(fileIconKey("clip.mp4")).toBe("video")
		expect(fileIconKey("song.mp3")).toBe("audio")
	})

	it("routes document, archive and code types", () => {
		expect(fileIconKey("report.pdf")).toBe("pdf")
		expect(fileIconKey("deck.pptx")).toBe("ppt")
		expect(fileIconKey("bundle.zip")).toBe("archive")
		expect(fileIconKey("main.rs")).toBe("code")
		// .markdown was already code pre-B39 (web's own CODE_EXTENSIONS already added it); .ahk is
		// B39's one documented web-side change (previously code nowhere on web, code on mobile).
		expect(fileIconKey("readme.markdown")).toBe("code")
		expect(fileIconKey("script.ahk")).toBe("code")
	})

	it("falls back to other for an unknown extension or a nameless (undecryptable) file", () => {
		expect(fileIconKey("mystery.xyz")).toBe("other")
		expect(fileIconKey("")).toBe("other")
	})
})

describe("shadeColor", () => {
	it("darkens each channel by the divisor and clamps to a padded two-digit hex", () => {
		expect(shadeColor("#808080", 2)).toBe("#404040")
		expect(shadeColor("#0f0f0f", 2)).toBe("#080808")
	})
})

describe("directoryFolderTint", () => {
	it("uses filen-mobile's exact default pair for an uncolored directory", () => {
		expect(directoryFolderTint("default")).toEqual({ path1: "#5398DF", path2: "#85BCFF" })
	})

	it("derives a darker tab shade from a named color body", () => {
		const tint = directoryFolderTint("red")

		expect(tint.path2).toBe("#FF3B30")
		// Literal, not shadeColor("#FF3B30", 1.3): an expected value computed with the function under test
		// proves only the routing, never the arithmetic on this divisor's own path (255/1.3, 59/1.3, 48/1.3).
		expect(tint.path1).toBe("#c42d25")
	})

	it("passes a custom hex through as the body color", () => {
		expect(directoryFolderTint("#abcdef").path2).toBe("#abcdef")
	})
})
