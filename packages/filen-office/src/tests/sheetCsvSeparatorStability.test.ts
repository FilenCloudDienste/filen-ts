import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectDelimiter, writeCsv } from "../core/sheet/csv/csvParse"
import { parseCsvFile } from "../core/sheet/csv/csvView"
import type { SheetLocale, SheetSessionSettings } from "../core/sheet/protocol"
import { openTextSession } from "../core/sheet/text"
import { CORPUS_DIR } from "./corpusDir"
import { cells, firstTile, savedBytes, tileTexts } from "./sheetSessionFixtures"

// A CSV does not say its separator, so a save must write one the next open detects again: a field holding any
// separator the detection weighs is quoted. A tie between separators goes to the session locale's list separator,
// as Excel takes it.

const GERMAN: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }
const ENGLISH: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" }
const encoder = new TextEncoder()
const CORPUS_CSV = join(CORPUS_DIR, "csv", "ccsv__csv-141.csv")

async function open(bytes: Uint8Array, settings?: SheetSessionSettings) {
	const opened = await openTextSession(bytes, { kind: "csv", ...(settings !== undefined && { settings }) }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	return opened.session
}

describe("CSV separator stability", () => {
	it("reopens an edited semicolon file whose quoted fields hold commas in its own columns", async () => {
		const session = await open(encoder.encode('"Smith, John";"1,5"\r\n"Doe, Jane";"2,5"\r\n"Roe, Rick";"3,5"\r\n'))

		expect((await session.command({ type: "cells.set", sheet: 0, cells: cells([[2, 1, "4,5"]]) })).ok).toBe(true)

		const reopened = await open(await savedBytes(session))
		const shown = tileTexts(await firstTile(reopened, 0))

		expect(shown.get("0,0")).toBe("Smith, John")
		expect(shown.get("0,1")).toBe("1,5")
		expect(shown.get("2,1")).toBe("4,5")
	})

	it("quotes a field holding another candidate separator when asked for a stable write", () => {
		expect(writeCsv([["a,b", "c|d", "e\tf", "g"]], ";", "\n", true)).toBe('"a,b";"c|d";"e\tf";g')
		expect(writeCsv([["a,b"]], ";", "\n")).toBe("a,b")
	})

	it.skipIf(!existsSync(CORPUS_CSV))("detects the same separator again after an edit of a real file", async () => {
		const bytes = new Uint8Array(readFileSync(CORPUS_CSV))
		const before = parseCsvFile(bytes, false).format.delimiter
		const session = await open(bytes.slice())

		expect((await session.command({ type: "cells.set", sheet: 0, cells: cells([[1, 1, 'zz,"q"\n2']]) })).ok).toBe(true)
		expect(parseCsvFile(await savedBytes(session), false).format.delimiter).toBe(before)
	})

	it("breaks a tie with the locale's list separator", async () => {
		const text = "1,5;2,5\r\n3,25;4,75\r\n5,5;6,5\r\n"

		expect(detectDelimiter(text, ";")).toBe(";")
		expect(detectDelimiter(text)).toBe(",")

		const shown = tileTexts(await firstTile(await open(encoder.encode(text), { locale: GERMAN }), 0))

		expect(shown.get("0,0")).toBe("1,5")
		expect(shown.get("2,1")).toBe("6,5")
	})

	it("keeps the untouched rows' bytes of a file whose separator was a tie the locale settled", async () => {
		const source = "1,5;2,5\r\n3,25;4,75\r\n5,5;6,5\r\n"
		const session = await open(encoder.encode(source), { locale: ENGLISH })

		expect((await session.command({ type: "cells.set", sheet: 0, cells: cells([[0, 0, "9"]]) })).ok).toBe(true)

		const saved = new TextDecoder().decode(await savedBytes(session))

		expect(saved).toBe("9,5;2,5\r\n3,25;4,75\r\n5,5;6,5\r\n")
	})

	it("keeps a clear majority over the locale's list separator", () => {
		expect(detectDelimiter("a,b,c\n1,2,3\n4;5,6\n", ";")).toBe(",")
	})

	it("saves an untouched file as its bytes, whatever its quoting", async () => {
		const source = encoder.encode("a,b;c\r\nx|y,z\r\n")
		const session = await open(source.slice(), { locale: GERMAN })

		expect(await savedBytes(session)).toEqual(source)
	})
})
