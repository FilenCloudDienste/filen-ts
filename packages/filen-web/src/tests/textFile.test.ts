import { describe, expect, it } from "vitest"
import { EditorState, Text } from "@codemirror/state"
import { detectLineEnding, encodeTextFile, readAsLegacy, readTextFile, utf8Format, writeTextFile } from "@/features/preview/lib/textFile"

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

	it("opens text a save would change read-only", () => {
		expect(readTextFile(Uint8Array.of(...bytes("Grüße, Köln, schön"), 0xff))).toMatchObject({ encoding: "utf-8", editableAsIs: false })
	})

	it("reads bytes that are not Unicode with the detector's guess, a choice over it", () => {
		expect(readTextFile(Uint8Array.of(0xcf, 0xf0, 0xe8), { guess: "windows-1251" })).toMatchObject({
			text: "При",
			encoding: "windows-1251"
		})
		expect(readTextFile(bytes("plain"), { guess: "windows-1251" }).encoding).toBe("utf-8")
		expect(readTextFile(Uint8Array.of(0xcf), { guess: "windows-1251", encoding: "koi8-r" }).encoding).toBe("koi8-r")
		expect(readAsLegacy(readTextFile(Uint8Array.of(0xcf)))).toBe(true)
		expect(readAsLegacy(readTextFile(bytes("plain")))).toBe(false)
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
})
