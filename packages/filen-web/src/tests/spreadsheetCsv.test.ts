import { describe, expect, it } from "vitest"
import { parseCsvFile, serializeCsv, type CsvFormat } from "@/features/spreadsheet/lib/csvView"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"
import { MAX_SHEET_CELLS } from "@/features/spreadsheet/lib/edits"

const encoder = new TextEncoder()

function utf16Bytes(text: string, littleEndian: boolean, bom: readonly number[]): Uint8Array {
	const body = new Uint8Array(text.length * 2)

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		const high = (code >> 8) & 0xff
		const low = code & 0xff

		if (littleEndian) {
			body[i * 2] = low
			body[i * 2 + 1] = high
		} else {
			body[i * 2] = high
			body[i * 2 + 1] = low
		}
	}

	const out = new Uint8Array(bom.length + body.length)

	out.set(bom)
	out.set(body, bom.length)

	return out
}

describe("CSV encodings", () => {
	it("reads and writes back a UTF-16LE file with its BOM", () => {
		const source = "name,city\r\ncafé,björk\r\n"
		const bytes = utf16Bytes(source, true, [0xff, 0xfe])
		const { rows, format } = parseCsvFile(bytes, false)

		expect(rows).toEqual([
			["name", "city"],
			["café", "björk"]
		])
		expect(format.encoding).toBe("utf-16le")
		expect(Array.from(serializeCsv(rows, format))).toEqual(Array.from(bytes))
	})

	it("reads and writes back a UTF-16BE file with its BOM", () => {
		const source = "a,b\r\n1,2\r\n"
		const bytes = utf16Bytes(source, false, [0xfe, 0xff])
		const { rows, format } = parseCsvFile(bytes, false)

		expect(format.encoding).toBe("utf-16be")
		expect(Array.from(serializeCsv(rows, format))).toEqual(Array.from(bytes))
	})

	it("round-trips a windows-1252 file byte for byte", () => {
		// "café,€" in windows-1252: é = 0xe9, € = 0x80.
		const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80])
		const { rows, format } = parseCsvFile(bytes, false)

		expect(rows).toEqual([["café", "€"]])
		expect(format.encoding).toBe("windows-1252")
		expect(Array.from(serializeCsv(rows, format))).toEqual(Array.from(bytes))
	})

	it("falls back to UTF-8 with a BOM once an edit adds a character windows-1252 cannot hold", () => {
		const { rows, format } = parseCsvFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), false)

		rows[0]?.push("日本語")

		const written = serializeCsv(rows, format)

		expect(Array.from(written.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
		expect(new TextDecoder("utf-8").decode(written)).toBe("café,日本語")
	})

	it("keeps a UTF-8 file's BOM presence as read", () => {
		const withBom = parseCsvFile(encoder.encode("﻿a,b\n"), false)
		const withoutBom = parseCsvFile(encoder.encode("a,b\n"), false)

		expect(withBom.format.bom).toBe(true)
		expect(withoutBom.format.bom).toBe(false)
		expect(Array.from(serializeCsv(withBom.rows, withBom.format).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
		expect(serializeCsv(withoutBom.rows, withoutBom.format)[0]).not.toBe(0xef)
	})
})

describe("CSV line endings", () => {
	it("preserves lone-CR line separators and a trailing CR", () => {
		const source = "a,b\rc,d\r"
		const { rows, format } = parseCsvFile(encoder.encode(source), false)

		expect(rows).toEqual([
			["a", "b"],
			["c", "d"]
		])
		expect(format.lineSeparator).toBe("\r")
		expect(format.trailingNewline).toBe(true)
		expect(new TextDecoder().decode(serializeCsv(rows, format))).toBe(source)
	})

	it("keeps a file with no trailing newline from gaining one", () => {
		const source = "a,b\nc,d"
		const { rows, format } = parseCsvFile(encoder.encode(source), false)

		expect(format.trailingNewline).toBe(false)
		expect(new TextDecoder().decode(serializeCsv(rows, format))).toBe(source)
	})
})

describe("CSV baseline parsing", () => {
	it("detects the delimiter among comma, semicolon, tab and pipe", () => {
		expect(parseCsvFile(encoder.encode("a|b|c\n1|2|3\n"), false).format.delimiter).toBe("|")
		expect(parseCsvFile(encoder.encode("a;b;c\n1;2;3\n"), false).format.delimiter).toBe(";")
	})

	it("keeps embedded newlines and quotes inside a quoted field", () => {
		const { rows } = parseCsvFile(encoder.encode('a,"line1\nline2",c\n'), false)

		expect(rows).toEqual([["a", "line1\nline2", "c"]])
	})

	it('keeps a doubled quote inside a quoted field as one literal "', () => {
		const { rows } = parseCsvFile(encoder.encode('a,"say ""hi""",c\n'), false)

		expect(rows).toEqual([["a", 'say "hi"', "c"]])
	})

	it("keeps ragged rows as given, padding nothing", () => {
		const { rows } = parseCsvFile(encoder.encode("a,b,c\n1,2\n"), false)

		expect(rows).toEqual([
			["a", "b", "c"],
			["1", "2"]
		])
	})

	it("keeps values starting with =, +, -, @ exactly as typed, with no formula-injection escaping", () => {
		const source = "=SUM(A1),+1,-1,@cmd\n"
		const { rows, format } = parseCsvFile(encoder.encode(source), false)

		expect(rows).toEqual([["=SUM(A1)", "+1", "-1", "@cmd"]])
		expect(new TextDecoder().decode(serializeCsv(rows, format))).toBe(source)
	})
})

describe("CsvDocument structural edits", () => {
	it("inserts far past the splice argument-count ceiling without throwing", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n"), false)
		const document = new CsvDocument(rows, format)

		expect(() => document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 150_000 })).not.toThrow()
		expect(document.doc().sheets[0]?.rowCount).toBe(150_001)
	})

	it("inserts far past the splice argument-count ceiling on columns without throwing", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n1,2\n"), false)
		const document = new CsvDocument(rows, format)

		expect(() => document.apply({ type: "insert", sheet: 0, axis: "cols", at: 1, count: 150_000 })).not.toThrow()
		expect(document.doc().sheets[0]?.colCount).toBe(150_002)
	})

	it("undoes a row insert, row delete, column insert and column delete back to the original grid", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n1,2\n3,4\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1, count: 1 })
		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 2, count: 1 })
		document.apply({ type: "insert", sheet: 0, axis: "cols", at: 1, count: 1 })
		document.apply({ type: "delete", sheet: 0, axis: "cols", at: 0, count: 1 })

		document.undo()
		document.undo()
		document.undo()
		document.undo()

		expect(new TextDecoder().decode(document.serialize().bytes)).toBe("a,b\n1,2\n3,4\n")
	})

	it("undoes an insert clamped past the last row without leaving empty rows behind", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n1,2\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "insert", sheet: 0, axis: "rows", at: 1000, count: 5 })
		document.undo()

		expect(new TextDecoder().decode(document.serialize().bytes)).toBe("a,b\n1,2\n")
	})

	it("redoes a structural edit after undoing it", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n1,2\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "delete", sheet: 0, axis: "rows", at: 0, count: 1 })
		document.undo()
		document.redo()

		expect(new TextDecoder().decode(document.serialize().bytes)).toBe("1,2\n")
	})
})

describe("CsvDocument saving", () => {
	it("is dirty after an edit and clean again once markSaved is called with that edit's version", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n"), false)
		const document = new CsvDocument(rows, format)

		const applied = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "x" }] })

		expect(applied.state.dirty).toBe(true)

		const { version } = document.serialize()
		const state = document.markSaved(version)

		expect(state.dirty).toBe(false)
	})

	it("goes dirty again after markSaved once another edit is applied, and clean after undoing it back", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "x" }] })
		document.markSaved(document.serialize().version)

		const second = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "y" }] })

		expect(second.state.dirty).toBe(true)
		expect(document.undo().state.dirty).toBe(false)
	})

	it("stays dirty after undoing a saved edit and typing a new one, though the depth returns to the saved one", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "X" }] })
		document.markSaved(document.serialize().version)
		document.undo()

		const after = document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "Y" }] })

		expect(after.state.dirty).toBe(true)
	})

	it("is clean again once redo lands back on the exact state that was saved", () => {
		const { rows, format } = parseCsvFile(encoder.encode("a,b\n"), false)
		const document = new CsvDocument(rows, format)

		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: "X" }] })
		document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 1, input: "Y" }] })
		document.markSaved(document.serialize().version)
		document.undo()

		const redone = document.redo()

		expect(redone.state.dirty).toBe(false)
	})
})

describe("CsvDocument undo-history memory budget", () => {
	it("bounds undo history to 100 steps", () => {
		const { rows, format } = parseCsvFile(encoder.encode(""), false)
		const document = new CsvDocument(rows, format)

		for (let i = 0; i < 101; i++) {
			document.apply({ type: "setCells", sheet: 0, cells: [{ row: 0, col: 0, input: String(i) }] })
		}

		for (let i = 0; i < 99; i++) {
			document.undo()
		}

		const last = document.undo()

		expect(last.state.canUndo).toBe(false)
		expect(document.undo().type).toBe("none")
	})

	it("bounds total snapshotted cells to MAX_SHEET_CELLS, evicting the oldest step first", () => {
		// Two column deletes together exceed the budget by construction; the first (oldest) must be evicted
		// once the second is applied, leaving only one step to undo.
		const chunk = Math.ceil(MAX_SHEET_CELLS / 2) + 1
		const bigRow = new Array<string>(chunk * 2).fill("")
		const format: CsvFormat = {
			delimiter: ",",
			lineSeparator: "\n",
			bom: false,
			trailingNewline: false,
			encoding: "utf-8",
			writable: true
		}
		const document = new CsvDocument([bigRow], format)

		document.apply({ type: "delete", sheet: 0, axis: "cols", at: 0, count: chunk })
		document.apply({ type: "delete", sheet: 0, axis: "cols", at: 0, count: chunk })

		const undone = document.undo()

		expect(undone.state.canUndo).toBe(false)
		expect(document.doc().sheets[0]?.colCount).toBe(chunk)
	})

	it("keeps a save point permanently dirty once its undo step falls out of the history budget", () => {
		const chunk = Math.ceil(MAX_SHEET_CELLS / 2) + 1
		const bigRow = new Array<string>(chunk * 2).fill("")
		const format: CsvFormat = {
			delimiter: ",",
			lineSeparator: "\n",
			bom: false,
			trailingNewline: false,
			encoding: "utf-8",
			writable: true
		}
		const document = new CsvDocument([bigRow], format)

		// The document's opened state (version 0) is implicitly "saved" and is never re-marked.
		document.apply({ type: "delete", sheet: 0, axis: "cols", at: 0, count: chunk })
		document.apply({ type: "delete", sheet: 0, axis: "cols", at: 0, count: chunk })

		const last = document.undo()

		// Only one of the two steps survived the budget, so the version-0 save point is unreachable.
		expect(last.state.canUndo).toBe(false)
		expect(last.state.dirty).toBe(true)
	})
})
