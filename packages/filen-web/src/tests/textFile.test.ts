import { describe, expect, it } from "vitest"
import { EditorState, Text } from "@codemirror/state"
import { detectLineEnding, readTextFile, writeTextFile } from "@/features/preview/lib/textFile"

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
		expect(writeTextFile(Text.of(["a", "b"]), { bom: false, lineEnding: "crlf" })).toBe("a\r\nb")
	})

	it("decodes invalid UTF-8 without throwing", () => {
		expect(readTextFile(new Uint8Array([0x61, 0xff, 0x62])).text).toBe("a�b")
	})
})
