import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OpcPackage, bytesSource, relationshipsPartName } from "../core/opc/index"
import { openXlsx, type XlsxWorkbook } from "../core/xlsx/read/index"
import { CellKind, type XlsxSheetModel } from "../core/xlsx/model/types"
import { saveXlsx } from "../core/xlsx/write/save"
import { CORPUS_DIR } from "./corpusDir"
import { changedEntries, equalBytes } from "./xlsxWriteFixtures"

// The splice writer over every openable OOXML spreadsheet in the corpus: an unedited save is the source byte for
// byte; a one-cell edit changes that cell's row alone (every other byte of the sheet part, and every other entry's
// compressed bytes, as in the source); an appended row with a new shared string changes the sheet's tail and the
// shared strings' root tag and end alone. Each edited save reopens with the session's cells.

const KINDS = ["xlsx", "xlsm", "xltx", "xltm"]
const FILES = KINDS.flatMap(kind =>
	existsSync(join(CORPUS_DIR, kind)) ? readdirSync(join(CORPUS_DIR, kind)).map(name => join(kind, name)) : []
)
// Floors and the refusal cap as fractions of the files present, so a partially fetched corpus still holds them. Over
// the full corpus 99% open, 85% take both edits and none is refused.
const OPENED_FLOOR = Math.ceil(FILES.length * 0.8)
const EDITED_FLOOR = Math.ceil(FILES.length * 0.65)
const REFERENCE_CAP = Math.floor(FILES.length * 0.01)

// A zip entry name or a part name, as compared: no leading slash, any case.
function entryKey(name: string): string {
	return name.replace(/^\//, "").toLowerCase()
}

// The bytes [from, to) of `before` that differ from `after`: what is left once their common head and tail go.
function differing(before: Uint8Array, after: Uint8Array): { from: number; to: number } {
	let head = 0

	while (head < before.length && head < after.length && before[head] === after[head]) head++

	let tail = 0

	while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail])
		tail++

	return { from: head, to: before.length - tail }
}

async function open(bytes: Uint8Array): Promise<XlsxWorkbook | undefined> {
	const opened = await openXlsx(bytesSource(bytes))

	return opened.ok ? opened.workbook : undefined
}

async function firstSheet(workbook: XlsxWorkbook): Promise<XlsxSheetModel | undefined> {
	const entry = workbook.sheets.find(sheet => sheet.kind === "worksheet" && sheet.part !== "")

	if (entry === undefined) return undefined

	try {
		return await workbook.load(entry.id)
	} catch {
		return undefined
	}
}

// Every cell of `a` as `b` holds it.
function sameCells(a: XlsxSheetModel, b: XlsxSheetModel): string | undefined {
	if (a.store.cellCount !== b.store.cellCount) return `${a.store.cellCount} cells, ${b.store.cellCount} read back`

	for (const block of a.store.blocks) {
		for (let index = 0; index < block.rowCount; index++) {
			const row = block.firstRow + (block.rows[index] ?? 0)

			for (let slot = block.rowStarts[index] ?? 0; slot < (block.rowStarts[index + 1] ?? 0); slot++) {
				const col = block.cols[slot] ?? 0
				const other = b.store.locate(row, col)

				if (other < 0) return `${row}:${col} missing`

				const otherBlock = b.store.blocks[Math.floor(other / 0x1000000)]
				const at = other % 0x1000000

				if (
					otherBlock === undefined ||
					otherBlock.kinds[at] !== block.kinds[slot] ||
					otherBlock.styles[at] !== block.styles[slot] ||
					(block.kinds[slot] === CellKind.NUMBER && otherBlock.values[at] !== block.values[slot])
				) {
					return `${row}:${col} differs`
				}
			}
		}
	}

	return undefined
}

// A row near the middle of the sheet holding a number cell, or any cell.
function middleCell(sheet: XlsxSheetModel): { row: number; col: number; block: number; index: number; slot: number } | undefined {
	const blocks = sheet.store.blocks
	let fallback: { row: number; col: number; block: number; index: number; slot: number } | undefined

	for (let b = Math.floor(blocks.length / 2); b < blocks.length; b++) {
		const block = blocks[b]

		if (block === undefined) continue

		for (let index = Math.floor(block.rowCount / 2); index < block.rowCount; index++) {
			for (let slot = block.rowStarts[index] ?? 0; slot < (block.rowStarts[index + 1] ?? 0); slot++) {
				const found = { row: block.firstRow + (block.rows[index] ?? 0), col: block.cols[slot] ?? 0, block: b, index, slot }

				if ((block.formulas?.[slot] ?? -1) >= 0) continue
				if (block.kinds[slot] === CellKind.NUMBER) return found

				fallback ??= found
			}
		}
	}

	return fallback
}

describe.skipIf(FILES.length === 0)("xlsx splice writer over the corpus", () => {
	it("saves every openable workbook unedited as its source bytes", { timeout: 600_000 }, async () => {
		let identical = 0
		let opened = 0

		for (const file of FILES) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file)))
			const workbook = await open(bytes)

			if (workbook === undefined) continue

			opened++

			const result = await saveXlsx({ opc: workbook.opc, workbook })

			expect(result.ok, file).toBe(true)

			if (result.ok && result.bytes !== undefined && equalBytes(result.bytes, bytes)) identical++
			else console.log(`not identical: ${file}`)
		}

		console.log(`xlsx unedited: ${identical}/${opened} identical`)
		expect(identical).toBe(opened)
		expect(opened).toBeGreaterThanOrEqual(OPENED_FLOOR)
	})

	it("changes only the edited row, and only what an appended row needs", { timeout: 900_000 }, async () => {
		const refusals = new Map<string, string[]>()
		let edited = 0

		for (const file of FILES) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file)))
			const workbook = await open(bytes)
			const sheet = workbook === undefined ? undefined : await firstSheet(workbook)

			if (workbook === undefined || sheet === undefined) continue

			const target = middleCell(sheet)
			const entry = workbook.sheets.find(candidate => candidate.model === sheet)

			if (target === undefined || entry === undefined) continue

			// One cell in the middle: its row alone changes.
			const block = sheet.store.blocks[target.block]
			const value = block?.kinds[target.slot] === CellKind.NUMBER ? (block.values[target.slot] ?? 0) + 1 : 4242.5

			sheet.store.setCell(target.row, target.col, CellKind.NUMBER, value, block?.styles[target.slot] ?? 0, -1)
			workbook.changes.sheetRows(entry.id)

			const result = await saveXlsx({ opc: workbook.opc, workbook })

			if (!result.ok) {
				refusals.set(result.reason, [...(refusals.get(result.reason) ?? []), `${file}: ${result.message}`])

				continue
			}

			edited++

			const output = result.bytes as Uint8Array
			const entries = await changedEntries(bytes, output)

			expect(entries, file).toEqual({ changed: [entry.part], added: [], removed: [] })

			const before = await (await OpcPackage.open(bytesSource(bytes))).read(entry.part)
			const after = await (await OpcPackage.open(bytesSource(output))).read(entry.part)
			const span = { start: block?.rowSpans[target.index * 2] ?? 0, end: block?.rowSpans[target.index * 2 + 1] ?? 0 }
			const diff = differing(before, after)
			// A dimension that did not cover the edited cell is widened: the difference then starts there.
			const dimension = sheet.sections.find(section => section.name === "dimension")
			const widened =
				dimension !== undefined &&
				!equalBytes(before.subarray(dimension.start, dimension.end), after.subarray(dimension.start, dimension.end))
			const from = widened ? dimension.start : span.start

			expect(
				diff.from >= from && diff.to <= span.end,
				`${file}: ${diff.from}-${diff.to} outside the row ${span.start}-${span.end}`
			).toBe(true)

			const reopened = await open(output)
			const read = reopened === undefined ? undefined : await reopened.load(entry.id)

			expect(read === undefined ? "does not reopen" : sameCells(sheet, read), file).toBeUndefined()

			// A new row past the last with a new shared string: the sheet's tail and the shared strings' ends change.
			const second = await open(bytes)
			const other = second === undefined ? undefined : await firstSheet(second)

			if (second === undefined || other === undefined) continue

			const string = second.sharedStrings.append(`appended ${file}`)

			second.sharedStrings.adjustReferences(1)
			second.changes.sharedStringsAppended()
			other.store.setCell(Math.min(other.store.rowExtent, 1_048_575), 0, CellKind.SHARED_STRING, string, 0, -1)
			second.changes.sheetRows(entry.id)

			const appended = await saveXlsx({ opc: second.opc, workbook: second })

			if (!appended.ok) {
				refusals.set(appended.reason, [...(refusals.get(appended.reason) ?? []), `${file} (appended): ${appended.message}`])

				continue
			}

			const appendedEntries = await changedEntries(bytes, appended.bytes as Uint8Array)
			const again = await open(appended.bytes as Uint8Array)
			const sharedStringsPart = async (workbook: XlsxWorkbook): Promise<string | undefined> => {
				const part = (await workbook.parts.relationships(workbook.workbookPart)).all.find(relationship =>
					relationship.type.endsWith("/sharedStrings")
				)?.partName

				return part !== undefined && workbook.opc.has(part) ? part : undefined
			}
			// The shared strings part as the source names it, or the one the save added when the source had none.
			const strings = await sharedStringsPart(second)
			const written = strings ?? (again === undefined ? undefined : await sharedStringsPart(again))
			const allowed = new Set(
				[entry.part, written, relationshipsPartName(second.workbookPart), "[Content_Types].xml"]
					.filter(part => part !== undefined)
					.map(entryKey)
			)

			expect(
				appendedEntries.changed.filter(name => !allowed.has(entryKey(name))),
				`${file}: entries changed beyond an appended row`
			).toEqual([])
			expect(appendedEntries.removed, `${file}: entries removed`).toEqual([])
			expect(appendedEntries.added.map(entryKey), `${file}: entries added`).toEqual(
				strings === undefined && written !== undefined ? [entryKey(written)] : []
			)

			// The shared strings part: its root tag (the counts) and an insertion, nothing else.
			if (strings !== undefined) {
				const before = await second.opc.read(strings)
				const after = await (await OpcPackage.open(bytesSource(appended.bytes as Uint8Array))).read(strings)
				const tagEnd = (bytes: Uint8Array): number => {
					let at = bytes.indexOf(60)

					while (bytes[at + 1] === 63 || bytes[at + 1] === 33) at = bytes.indexOf(60, at + 1)

					return bytes.indexOf(62, at) + 1
				}
				const diff = differing(before.subarray(tagEnd(before)), after.subarray(tagEnd(after)))

				expect(diff.from, `${file}: shared strings changed beyond an insertion`).toBe(diff.to)
			}

			const back = again === undefined ? undefined : await again.load(entry.id)

			expect(back === undefined ? "does not reopen" : sameCells(other, back), `${file} (appended)`).toBeUndefined()
			expect(again?.sharedStrings.text(string), file).toBe(`appended ${file}`)
		}

		for (const [reason, files] of refusals) console.log(`refused (${reason}): ${files.length}\n  ${files.slice(0, 10).join("\n  ")}`)
		console.log(`xlsx edited: ${edited} saved, ${[...refusals.values()].reduce((sum, files) => sum + files.length, 0)} refused`)

		// The only refusals are workbooks the reader misreads (style records inside mc:AlternateContent).
		expect([...refusals.keys()].filter(reason => reason !== "reference")).toEqual([])
		expect(refusals.get("reference")?.length ?? 0).toBeLessThanOrEqual(REFERENCE_CAP)
		expect(edited).toBeGreaterThanOrEqual(EDITED_FLOOR)
	})
})
