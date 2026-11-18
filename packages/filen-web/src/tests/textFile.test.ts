import { describe, expect, it } from "vitest"
import { EditorState, Text } from "@codemirror/state"
import i18n from "i18next"
import { SUBTITLE_ENCODINGS, TEXT_ENCODINGS } from "@filen/shared/textEncoding"
import {
	detectLineEnding,
	encodeTextFile,
	encodingOptionLabel,
	encodingShortName,
	readTextFile,
	readUnicodeTextFile,
	utf8Format,
	writeTextFile
} from "@/features/preview/lib/textFile"
import { otherLineBreaks } from "@/features/preview/lib/lineBreaks"
import "@/lib/i18n"

// Saving a text file changes only what was edited: its byte order mark and its line ending (which the editor does
// not keep, splitting lines on any ending) come back on save.

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

// The file as the editor opens it, then saved.
function roundTrip(text: string, edit?: (state: EditorState) => EditorState): Uint8Array {
	const file = readTextFile(bytes(text))
	let state = EditorState.create({ doc: file.text })

	if (edit !== undefined) {
		state = edit(state)
	}

	return bytes(writeTextFile(state.doc, file))
}

describe("text file fidelity", () => {
	it("keeps CRLF line endings through the editor", () => {
		const original = "first\r\nsecond\r\n\r\nlast"

		expect(readTextFile(bytes(original)).lineEnding).toBe("crlf")
		expect(roundTrip(original)).toEqual(bytes(original))
	})

	it("keeps a byte order mark, which the decoder would otherwise drop", () => {
		const original = "﻿name,value\r\na,1\r\n"
		const file = readTextFile(bytes(original))

		expect(file.bom).toBe(true)
		expect(file.text.startsWith("﻿")).toBe(false)
		expect(roundTrip(original)).toEqual(bytes(original))
		expect(Array.from(roundTrip(original).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
	})

	it("writes edits with the file's own ending, whatever ending they were typed or pasted with", () => {
		const saved = roundTrip("a\r\nb", state => state.update({ changes: { from: 1, insert: "\nx\ny" } }).state)

		expect(new TextDecoder().decode(saved)).toBe("a\r\nx\r\ny\r\nb")
	})

	it("leaves LF files and files without a mark as they are", () => {
		expect(roundTrip("one\ntwo\n")).toEqual(bytes("one\ntwo\n"))
		expect(readTextFile(bytes("one\ntwo")).bom).toBe(false)
		expect(roundTrip("")).toEqual(bytes(""))
	})

	it("keeps classic Mac CR endings", () => {
		expect(readTextFile(bytes("a\rb\rc")).lineEnding).toBe("cr")
		expect(roundTrip("a\rb\rc")).toEqual(bytes("a\rb\rc"))
	})

	it("saves a mixed file with the ending most of its lines use", () => {
		expect(detectLineEnding("a\r\nb\r\nc\nd")).toBe("crlf")
		expect(detectLineEnding("a\nb\nc\r\nd")).toBe("lf")
		expect(detectLineEnding("single line")).toBe("lf")
		expect(writeTextFile(Text.of(["a", "b"]), { encoding: "utf-8", bom: false, lineEnding: "crlf" })).toBe("a\r\nb")
	})

	it("opens strict UTF-8 editable, with or without its mark", () => {
		expect(readTextFile(bytes("plain")).editableAsIs).toBe(true)
		expect(readTextFile(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)).editableAsIs).toBe(true)
	})

	it("opens text a save writes back in its own encoding editable, and saves it in that encoding", () => {
		const latin = readTextFile(Uint8Array.of(0x61, 0xff, 0x62))
		const utf16 = readTextFile(Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00))

		// Not UTF-8: read with the browser language's codepage (windows-1252 for English).
		expect(latin).toMatchObject({ text: "aÿb", encoding: "windows-1252", editableAsIs: true })
		expect(encodeTextFile(Text.of(["aÿb"]), latin)).toEqual({ bytes: Uint8Array.of(0x61, 0xff, 0x62) })
		expect(utf16).toMatchObject({ text: "hi", encoding: "utf-16le", bom: true, editableAsIs: true })
		expect(encodeTextFile(Text.of(["hi"]), utf16)).toEqual({ bytes: Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00) })
	})

	it("opens text a save would change read-only, and says when bytes could not be read", () => {
		expect(readTextFile(Uint8Array.of(...bytes("Grüße, Köln, schön"), 0xff))).toMatchObject({
			encoding: "utf-8",
			editableAsIs: false,
			lossy: true
		})
		expect(readTextFile(bytes("plain")).lossy).toBe(false)
	})

	it("reads bytes that are not Unicode with the detector's guess, a choice over it", () => {
		expect(readTextFile(Uint8Array.of(0xcf, 0xf0, 0xe8), { guess: "windows-1251" })).toMatchObject({
			text: "При",
			encoding: "windows-1251"
		})
		expect(readTextFile(bytes("plain"), { guess: "windows-1251" }).encoding).toBe("utf-8")
		expect(readTextFile(Uint8Array.of(0xcf), { guess: "windows-1251", encoding: "koi8-r" }).encoding).toBe("koi8-r")
		expect(readUnicodeTextFile(Uint8Array.of(0xcf))).toBeNull()
		expect(readUnicodeTextFile(bytes("plain"))).toMatchObject({ text: "plain", encoding: "utf-8" })
	})

	it("reads the bytes with a chosen encoding", () => {
		expect(readTextFile(Uint8Array.of(0xcf, 0xf0, 0xe8), { encoding: "windows-1251" })).toMatchObject({
			text: "При",
			encoding: "windows-1251"
		})
	})

	it("refuses a character the encoding cannot hold, and converts to UTF-8 without another encoding's mark", () => {
		const utf16 = readTextFile(Uint8Array.of(0xff, 0xfe, 0x68, 0x00))

		expect(encodeTextFile(Text.of(["a", "\u2603"]), { encoding: "windows-1252", bom: false, lineEnding: "lf" })).toEqual({
			unencodable: { line: 2, column: 1, char: "\u2603" }
		})
		expect(utf8Format(utf16)).toEqual({ encoding: "utf-8", bom: false, lineEnding: "lf" })
		expect(utf8Format({ encoding: "utf-8", bom: true, lineEnding: "crlf" })).toEqual({
			encoding: "utf-8",
			bom: true,
			lineEnding: "crlf"
		})
	})

	// A file most lines of which end in CRLF, some in LF: an unedited save writes every line's own ending back.
	it("saves a file with mixed endings byte for byte", () => {
		const original = "one\r\ntwo\nthree\r\nfour"
		const file = readTextFile(bytes(original))

		expect(file.lineEnding).toBe("crlf")
		expect(writeTextFile(EditorState.create({ doc: file.text }).doc, file, otherLineBreaks(file.text, "\r\n"))).toBe(original)
	})
})

// Every encoding a text file may be read with, as the pickers name it in English: family, then technical name.
const ENGLISH_OPTIONS: readonly [string, string][] = [
	["utf-8", "Unicode (UTF-8)"],
	["utf-16le", "Unicode (UTF-16 LE)"],
	["utf-16be", "Unicode (UTF-16 BE)"],
	["windows-1250", "Central European (Windows-1250)"],
	["windows-1251", "Cyrillic (Windows-1251)"],
	["windows-1252", "Western European (Windows-1252)"],
	["windows-1253", "Greek (Windows-1253)"],
	["windows-1254", "Turkish (Windows-1254)"],
	["windows-1255", "Hebrew (Windows-1255)"],
	["windows-1256", "Arabic (Windows-1256)"],
	["windows-1257", "Baltic (Windows-1257)"],
	["windows-1258", "Vietnamese (Windows-1258)"],
	["windows-874", "Thai (Windows-874)"],
	["koi8-r", "Cyrillic (KOI8-R)"],
	["gb18030", "Chinese Simplified (GB18030)"],
	["big5", "Chinese Traditional (Big5)"],
	["shift_jis", "Japanese (Shift JIS)"],
	["euc-jp", "Japanese (EUC-JP)"],
	["euc-kr", "Korean (EUC-KR)"],
	["koi8-u", "Cyrillic (KOI8-U)"],
	["ibm866", "Cyrillic (IBM 866)"],
	["iso-8859-2", "Central European (ISO 8859-2)"],
	["iso-8859-4", "Baltic (ISO 8859-4)"],
	["iso-8859-5", "Cyrillic (ISO 8859-5)"],
	["iso-8859-6", "Arabic (ISO 8859-6)"],
	["iso-8859-7", "Greek (ISO 8859-7)"],
	["iso-8859-8", "Hebrew (ISO 8859-8)"],
	["iso-8859-10", "Nordic (ISO 8859-10)"],
	["iso-8859-13", "Baltic (ISO 8859-13)"],
	["iso-8859-15", "Western European (ISO 8859-15)"],
	["macintosh", "Western European (Mac OS Roman)"]
]

describe("encoding names", () => {
	it("names every encoding by its technical name in the status", () => {
		expect(TEXT_ENCODINGS.map(({ label }) => [label, encodingShortName(label)])).toEqual(
			ENGLISH_OPTIONS.map(([label, option]) => [label, /\(([^)]+)\)$/.exec(option)?.[1]])
		)
		expect(encodingShortName("x-unknown")).toBe("X-UNKNOWN")
	})

	it("lists every encoding by family and technical name", () => {
		const t = i18n.getFixedT("en", "preview")

		expect(TEXT_ENCODINGS.map(entry => [entry.label, encodingOptionLabel(entry, t)])).toEqual(ENGLISH_OPTIONS)
		expect(SUBTITLE_ENCODINGS.every(entry => TEXT_ENCODINGS.includes(entry))).toBe(true)
	})

	it("names the family in the UI language and keeps the technical name", () => {
		i18n.addResource("xx", "preview", "previewTextEncodingFamilyCyrillic", "Kyrillisch")
		i18n.addResource("xx", "preview", "previewTextEncodingOption", "{{name}} – {{family}}")

		const cyrillic = TEXT_ENCODINGS.find(entry => entry.label === "windows-1251")

		expect(cyrillic === undefined ? null : encodingOptionLabel(cyrillic, i18n.getFixedT("xx", "preview"))).toBe(
			"Windows-1251 – Kyrillisch"
		)
	})
})
