import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseCsvFile, serializeCsv, type CsvFormat } from "../core/sheet/csv/csvView"
import { openTextSession } from "../core/sheet/text"
import { CORPUS_DIR } from "./corpusDir"
import { cells, savedBytes } from "./sheetSessionFixtures"
import { equalBytes } from "./xlsxWriteFixtures"

// Every CSV and TSV of the corpus through the text engine: it opens, an untouched save is its source bytes, its rows
// written back read as the same rows in the same format, and after a one-cell edit the save still reads back as the
// edited rows with the same separator. Changed-line counts are not pinned: an edited save re-quotes every row minimally.

const COMMITTED = join(import.meta.dirname, "..", "..", "corpus")
const FAMILIES = ["csv", "tsv"] as const
const FILES = FAMILIES.flatMap(family =>
	existsSync(join(CORPUS_DIR, family)) ? readdirSync(join(CORPUS_DIR, family)).map(name => ({ family, name })) : []
)

interface CatalogueEntry {
	readonly path: string
	readonly encoding: string
	readonly delimiter?: string
	readonly lineEndings: string
}

const catalogue = new Map(
	(JSON.parse(readFileSync(join(COMMITTED, "catalogue.json"), "utf8")) as { files: CatalogueEntry[] }).files.map(entry => [
		entry.path,
		entry
	])
)

// The catalogue's encoding names in ours; "ascii" is valid UTF-8 without a BOM, and "8-bit (not UTF-8)" is what we read
// as windows-1252.
const ENCODINGS: Readonly<Record<string, Pick<CsvFormat, "encoding" | "bom">>> = {
	ascii: { encoding: "utf-8", bom: false },
	"utf-8": { encoding: "utf-8", bom: false },
	"utf-8-bom": { encoding: "utf-8", bom: true },
	"utf-16le-bom": { encoding: "utf-16le", bom: true },
	"utf-16be-bom": { encoding: "utf-16be", bom: true },
	"8-bit (not UTF-8)": { encoding: "windows-1252", bom: false }
}
// A single kind of line end in the catalogue names ours; a mix ("crlf+lf") does not say which comes first, and ours is
// the first one read.
const LINE_ENDINGS: Readonly<Record<string, CsvFormat["lineSeparator"]>> = { lf: "\n", crlf: "\r\n", cr: "\r" }
// The catalogue names a tab "tab".
const DELIMITERS: Readonly<Record<string, string>> = { tab: "\t" }
// Where the catalogue's sniffed delimiter does not name our reading: a .tsv is tab-separated by its extension, whatever
// character a sniff over its lines finds most.
const CATALOGUE_DELIMITER_EXCEPTIONS: ReadonlySet<string> = new Set(["tsv/tika__migration-overlay.tsv", "tsv/tika__text-test.tsv"])

function shape(format: CsvFormat) {
	return { delimiter: format.delimiter, encoding: format.encoding, bom: format.bom, lineSeparator: format.lineSeparator }
}

// The first row where the two differ, as text, or undefined: a deep equality over a file's million cells (or a byte array's
// million keys) would take more memory than the file, and its diff more again.
function firstRowDiff(actual: readonly (readonly string[])[], expected: readonly (readonly string[])[]): string | undefined {
	const length = Math.max(actual.length, expected.length)

	for (let row = 0; row < length; row++) {
		const a = actual[row]
		const e = expected[row]

		if (a === undefined || e === undefined || a.length !== e.length || a.some((value, col) => value !== e[col]))
			return `row ${row}: ${JSON.stringify(a)} != ${JSON.stringify(e)}`
	}

	return undefined
}

function expectRoundTrip(bytes: Uint8Array, tabSeparated: boolean): ReturnType<typeof parseCsvFile> {
	const parsed = parseCsvFile(bytes, tabSeparated)
	const again = parseCsvFile(serializeCsv(parsed.rows, parsed.format), tabSeparated)

	expect(firstRowDiff(again.rows, parsed.rows)).toBeUndefined()
	expect(shape(again.format)).toEqual(shape(parsed.format))

	return parsed
}

describe.skipIf(FILES.length === 0)("CSV and TSV corpus", () => {
	it.each(FILES)(
		"$family/$name opens, saves untouched as its bytes and round-trips an edit",
		{ timeout: 60_000 },
		async ({ family, name }) => {
			const path = `${family}/${name}`
			const source = new Uint8Array(readFileSync(join(CORPUS_DIR, path)))
			const tabSeparated = family === "tsv"
			const parsed = expectRoundTrip(source, tabSeparated)
			const entry = catalogue.get(path)

			expect(entry).toBeDefined()

			if (entry !== undefined) {
				expect({ encoding: parsed.format.encoding, bom: parsed.format.bom }).toEqual(ENCODINGS[entry.encoding])

				const lineSeparator = LINE_ENDINGS[entry.lineEndings]

				if (lineSeparator !== undefined) expect(parsed.format.lineSeparator).toBe(lineSeparator)
				if (entry.delimiter !== undefined && !CATALOGUE_DELIMITER_EXCEPTIONS.has(path))
					expect(parsed.format.delimiter).toBe(DELIMITERS[entry.delimiter] ?? entry.delimiter)
			}

			const opened = await openTextSession(source.slice(), { kind: family }, () => undefined)

			expect(opened.kind).toBe("opened")

			if (opened.kind !== "opened") return

			const { session } = opened

			try {
				if (!parsed.format.writable) {
					expect(await session.intent()).toEqual({ state: "viewOnly", reason: "unsafe" })

					return
				}

				expect(equalBytes(await savedBytes(session), source)).toBe(true)
				expect((await session.command({ type: "cells.set", sheet: 0, cells: cells([[0, 0, "edited"]]) })).ok).toBe(true)

				const saved = await savedBytes(session)
				const edited = expectRoundTrip(saved, tabSeparated)
				const expected = parsed.rows.map(row => row.slice())

				if (expected.length === 0) expected.push([])

				const first = expected[0] ?? []

				first[0] = "edited"
				expected[0] = first

				expect(firstRowDiff(edited.rows, expected)).toBeUndefined()
				expect(edited.format.delimiter).toBe(parsed.format.delimiter)
			} finally {
				session.close()
			}
		}
	)

	// The file states LibreOffice's reading of each malformed line in its "shall be:" column; that reading is
	// deliberately not followed. These pin the current one: a quoted run ends at its closing quote and the characters
	// after it join the field, quotes and all. Microsoft publishes no specification of how Excel reads malformed quotes,
	// so this documents current behaviour, not confirmed Office parity.
	it("pins the reading of lo__fdo48621_broken_quotes.csv's malformed quotes", () => {
		const path = join(CORPUS_DIR, "csv", "lo__fdo48621_broken_quotes.csv")

		if (!existsSync(path)) return

		const { rows, format } = parseCsvFile(new Uint8Array(readFileSync(path)), false)

		expect(format.delimiter).toBe(",")
		expect(rows[1]).toEqual(['abc d "ef"', "shall be:", 'abc" d "ef'])
		expect(rows[2]).toEqual(["ab", ' "a"', "shall be:", 'a"b, "a'])
	})
})
