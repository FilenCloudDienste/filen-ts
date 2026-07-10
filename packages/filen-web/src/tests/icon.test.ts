import { describe, expect, it } from "vitest"
import { directoryFolderTint, fileIconKey, shadeColor } from "@/features/drive/lib/icon.logic"

describe("fileIconKey", () => {
	it("routes image/video/audio by extension (case-insensitive), including svg and heic as images", () => {
		expect(fileIconKey("photo.PNG")).toBe("image")
		expect(fileIconKey("vector.svg")).toBe("image")
		expect(fileIconKey("raw.heic")).toBe("image")
		expect(fileIconKey("clip.mp4")).toBe("video")
		expect(fileIconKey("song.mp3")).toBe("audio")
	})

	it("routes document and office types", () => {
		expect(fileIconKey("report.pdf")).toBe("pdf")
		expect(fileIconKey("notes.txt")).toBe("txt")
		expect(fileIconKey("a.doc")).toBe("doc")
		expect(fileIconKey("a.docx")).toBe("doc")
		expect(fileIconKey("deck.pptx")).toBe("ppt")
		expect(fileIconKey("sheet.xlsx")).toBe("xls")
	})

	it("routes archives, code, binaries and platform packages", () => {
		expect(fileIconKey("bundle.zip")).toBe("archive")
		expect(fileIconKey("main.rs")).toBe("code")
		expect(fileIconKey("readme.md")).toBe("code")
		expect(fileIconKey("service.log")).toBe("code")
		expect(fileIconKey("app.exe")).toBe("exe")
		expect(fileIconKey("app.apk")).toBe("android")
		expect(fileIconKey("app.ipa")).toBe("apple")
		expect(fileIconKey("disk.iso")).toBe("iso")
		expect(fileIconKey("model.cad")).toBe("cad")
		expect(fileIconKey("art.psd")).toBe("psd")
	})

	it("falls back to other for an unknown extension or a nameless (undecryptable) file", () => {
		expect(fileIconKey("mystery.xyz")).toBe("other")
		expect(fileIconKey("noextension")).toBe("other")
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
		expect(tint.path1).toBe(shadeColor("#FF3B30", 1.3))
	})

	it("passes a custom hex through as the body color", () => {
		expect(directoryFolderTint("#abcdef").path2).toBe("#abcdef")
	})
})
