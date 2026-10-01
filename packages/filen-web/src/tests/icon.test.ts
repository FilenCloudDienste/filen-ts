import { describe, expect, it } from "vitest"
import { fileIconKey } from "@/features/drive/lib/icon.logic"

// Full extension-routing coverage lives in @filen/shared's fileIcon.test.ts now — fileIconKey here is
// a thin wrapper (icon.logic.ts) deriving `ext` via fileTypeExtension and delegating to the shared
// classifier, so this only proves the wrapper resolves a name (and mime) to the right key.
describe("fileIconKey", () => {
	it("routes image/video/audio by extension (case-insensitive)", () => {
		expect(fileIconKey("photo.PNG")).toBe("image")
		expect(fileIconKey("DSCF0001.HIF")).toBe("image")
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

	it("routes a well-known extensionless name like the extension it reads as", () => {
		expect(fileIconKey("LICENSE")).toBe("txt")
		expect(fileIconKey(".gitignore")).toBe("txt")
		expect(fileIconKey("Makefile")).toBe("code")
		expect(fileIconKey("Dockerfile")).toBe("code")
		expect(fileIconKey(".bashrc")).toBe("code")
	})

	it("routes by mime when the extension is missing or unknown, never over a known one", () => {
		expect(fileIconKey("clip", "video/mp4")).toBe("video")
		expect(fileIconKey("export.dat", "text/plain")).toBe("txt")
		expect(fileIconKey("photo.jpg", "video/mp4")).toBe("image")
		expect(fileIconKey("mystery", "application/octet-stream")).toBe("other")
	})

	it("falls back to other for an unknown extension or a nameless (undecryptable) file", () => {
		expect(fileIconKey("mystery.xyz")).toBe("other")
		expect(fileIconKey("")).toBe("other")
	})
})
