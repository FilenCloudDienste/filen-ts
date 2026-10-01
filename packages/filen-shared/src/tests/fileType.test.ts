import { describe, expect, it } from "vitest"
import { effectiveExtension, extensionForFileName, extensionForMime } from "@filen/shared"

const KNOWN = new Set(["txt", "md", "json", "jpg", "mp4", "pdf", "sh", "ini", "makefile", "dockerfile", "rb", "conf"])
const isKnown = (extension: string) => KNOWN.has(extension)

describe("extensionForFileName", () => {
	it("reads extension-less well-known names, case-insensitively", () => {
		expect(extensionForFileName("LICENSE")).toBe("txt")
		expect(extensionForFileName("Makefile")).toBe("makefile")
		expect(extensionForFileName("Dockerfile")).toBe("dockerfile")
		expect(extensionForFileName("Gemfile")).toBe("rb")
	})

	it("reads known dotfiles, and every .env variant", () => {
		expect(extensionForFileName(".gitignore")).toBe("txt")
		expect(extensionForFileName(".bashrc")).toBe("sh")
		expect(extensionForFileName(".env")).toBe("ini")
		expect(extensionForFileName(".env.production")).toBe("ini")
	})

	it("leaves unknown names and binary dotfiles alone", () => {
		expect(extensionForFileName("notes")).toBeNull()
		expect(extensionForFileName(".DS_Store")).toBeNull()
	})
})

describe("extensionForMime", () => {
	it("maps a MIME type, ignoring case and parameters", () => {
		expect(extensionForMime("image/JPEG")).toBe("jpg")
		expect(extensionForMime("application/json; charset=utf-8")).toBe("json")
	})

	it("keeps the macro-enabled workbook type apart from plain .xlsx", () => {
		expect(extensionForMime("application/vnd.ms-excel.sheet.macroEnabled.12")).toBe("xlsm")
	})

	it("reads any other text type as plain text", () => {
		expect(extensionForMime("text/x-unknown-thing")).toBe("txt")
	})

	it("knows nothing about an absent or opaque type", () => {
		expect(extensionForMime(undefined)).toBeNull()
		expect(extensionForMime("")).toBeNull()
		expect(extensionForMime("application/octet-stream")).toBeNull()
	})
})

describe("effectiveExtension", () => {
	it("keeps a known extension, whatever the MIME type says", () => {
		expect(effectiveExtension("photo.JPG", "application/octet-stream", isKnown)).toBe("jpg")
		expect(effectiveExtension("notes.md", "text/plain", isKnown)).toBe("md")
	})

	it("reads a well-known name before the MIME type", () => {
		expect(effectiveExtension("LICENSE", "application/octet-stream", isKnown)).toBe("txt")
		expect(effectiveExtension(".gitignore", undefined, isKnown)).toBe("txt")
	})

	it("falls back to the MIME type for an unknown or missing extension", () => {
		expect(effectiveExtension("clip", "video/mp4", isKnown)).toBe("mp4")
		expect(effectiveExtension("data.weird", "application/json", isKnown)).toBe("json")
		expect(effectiveExtension("notes", "text/plain", isKnown)).toBe("txt")
	})

	it("ignores a MIME type the app cannot classify, keeping the file's own extension", () => {
		expect(effectiveExtension("scan.weird", "image/tiff", isKnown)).toBe("weird")
		expect(effectiveExtension("blob", "application/octet-stream", isKnown)).toBe("")
	})
})
