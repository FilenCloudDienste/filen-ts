import { describe, expect, it } from "vitest"
import {
	isEditablePresentationExtension,
	PRESENTATION_EXTENSIONS,
	presentationFileKind,
	presentationSaveFormat,
	sniffPresentationKind
} from "@/features/presentation/lib/fileKind"

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

// A zip whose first entry is the stored ODF `mimetype` (ODF 1.3 Part 2 §3.3: first, uncompressed, no extra field).
function odfHead(mime: string): Uint8Array {
	const name = new TextEncoder().encode("mimetype")
	const body = new TextEncoder().encode(mime)
	const head = new Uint8Array(30 + name.length + body.length)

	head.set(ZIP, 0)
	head[26] = name.length
	head.set(name, 30)
	head.set(body, 30 + name.length)

	return head
}

describe("presentation file kinds", () => {
	it("lists every deck, template, show, macro-enabled, OpenDocument and 97–2003 extension", () => {
		expect([...PRESENTATION_EXTENSIONS].sort()).toEqual(
			["odp", "otp", "pot", "potm", "potx", "pps", "ppsm", "ppsx", "ppt", "pptm", "pptx"].sort()
		)
	})

	it.each([
		["pptx", "pptx", "pptx"],
		["pptm", "pptx", "pptm"],
		["potx", "pptx", "potx"],
		["potm", "pptx", "potm"],
		["ppsx", "pptx", "ppsx"],
		["ppsm", "pptx", "ppsm"],
		["odp", "odp", "odp"],
		["otp", "odp", "otp"],
		["ppt", "ppt", "ppt"],
		["pps", "ppt", "pps"],
		["pot", "ppt", "pot"]
	] as const)(".%s opens as %s (variant %s)", (extension, format, variant) => {
		expect(presentationFileKind(extension)).toEqual({ format, variant })
	})

	it("knows nothing else, not even names on the prototype", () => {
		expect(presentationFileKind("docx")).toBeNull()
		expect(presentationFileKind("constructor")).toBeNull()
		expect(presentationFileKind("")).toBeNull()
	})

	it("edits OOXML and OpenDocument decks, and only views the 97–2003 ones", () => {
		for (const extension of ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "odp", "otp"]) {
			expect(isEditablePresentationExtension(extension)).toBe(true)
		}

		for (const extension of ["ppt", "pps", "pot", "key", "txt"]) {
			expect(isEditablePresentationExtension(extension)).toBe(false)
		}
	})

	it("tells a rename apart by the file its name promises: each OOXML and ODF extension, one 97–2003 format", () => {
		expect(presentationSaveFormat("pptx")).toBe("pptx")
		expect(presentationSaveFormat("ppsm")).toBe("ppsm")
		expect(presentationSaveFormat("otp")).toBe("otp")
		expect(presentationSaveFormat("pps")).toBe("ppt")
		expect(presentationSaveFormat("pot")).toBe("ppt")
		expect(presentationSaveFormat("md")).toBeNull()
	})

	it("reads what a file is from its first bytes", () => {
		expect(sniffPresentationKind(new Uint8Array([...ZIP, 0x14, 0x00]))).toBe("pptx")
		expect(sniffPresentationKind(odfHead("application/vnd.oasis.opendocument.presentation"))).toBe("odp")
		expect(sniffPresentationKind(odfHead("application/vnd.oasis.opendocument.presentation-template"))).toBe("odp")
		// Another ODF document is no presentation: the zip check alone would call it one.
		expect(sniffPresentationKind(odfHead("application/vnd.oasis.opendocument.text"))).toBeNull()
		expect(sniffPresentationKind(new Uint8Array(OLE2))).toBe("ppt")
		expect(sniffPresentationKind(new TextEncoder().encode('msgid ""\nmsgstr ""\n'))).toBeNull()
		expect(sniffPresentationKind(new Uint8Array(0))).toBeNull()
	})
})
