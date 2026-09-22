import { describe, expect, it } from "vitest"
import { CODE_FILE_EXTENSIONS, HEIC_EXTENSIONS_UPLOAD, isHeicFileName } from "@filen/shared"

describe("CODE_FILE_EXTENSIONS", () => {
	it("is the verified 53-entry intersection, lowercase and dot-less", () => {
		expect(CODE_FILE_EXTENSIONS.size).toBe(53)

		for (const ext of CODE_FILE_EXTENSIONS) {
			expect(ext).toBe(ext.toLowerCase())
			expect(ext.startsWith(".")).toBe(false)
		}
	})

	it("contains representative source-code extensions", () => {
		expect(CODE_FILE_EXTENSIONS.has("ts")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("tsx")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("rs")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("gradle")).toBe(true)
		expect(CODE_FILE_EXTENSIONS.has("proto")).toBe(true)
	})

	it("excludes md/markdown/log — each app composes those back in locally", () => {
		expect(CODE_FILE_EXTENSIONS.has("md")).toBe(false)
		expect(CODE_FILE_EXTENSIONS.has("markdown")).toBe(false)
		expect(CODE_FILE_EXTENSIONS.has("log")).toBe(false)
	})

	it("excludes ahk — left to the icon classifier batch to decide", () => {
		expect(CODE_FILE_EXTENSIONS.has("ahk")).toBe(false)
	})
})

describe("HEIC_EXTENSIONS_UPLOAD", () => {
	it("is mobile's four HEIC/HEIF variants, lowercase and dot-less", () => {
		expect(HEIC_EXTENSIONS_UPLOAD).toEqual(new Set(["heic", "heif", "heics", "heifs"]))
	})
})

describe("isHeicFileName", () => {
	it("matches case-insensitively against the given set", () => {
		expect(isHeicFileName("photo.heic", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
		expect(isHeicFileName("photo.HEIC", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
		expect(isHeicFileName("burst.heics", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
		expect(isHeicFileName("burst.HEIFS", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
	})

	it("returns false for a non-matching extension", () => {
		expect(isHeicFileName("photo.jpg", HEIC_EXTENSIONS_UPLOAD)).toBe(false)
	})

	it("does not match when the target extension is not the final one", () => {
		expect(isHeicFileName("photo.heic.jpg", HEIC_EXTENSIONS_UPLOAD)).toBe(false)
	})

	it("performs no URI truncation — a query/fragment or path left in by the caller stays in", () => {
		expect(isHeicFileName("photo.heic?download=1", HEIC_EXTENSIONS_UPLOAD)).toBe(false)
		expect(isHeicFileName("var/mobile/photo.heic", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
	})

	it("is parameterised over the extension set — web's narrower set stays independent", () => {
		const webHeicExtensions = new Set(["heic", "heif"])

		expect(isHeicFileName("burst.heics", webHeicExtensions)).toBe(false)
		expect(isHeicFileName("burst.heics", HEIC_EXTENSIONS_UPLOAD)).toBe(true)
	})
})
