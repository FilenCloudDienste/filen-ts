import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { SheetSession } from "../core/sheet/session"
import type { XlsxDocument } from "../core/xlsx/edit/document"
import type { SheetStore } from "../core/xlsx/model/store"
import { FormulaKind } from "../core/xlsx/model/types"
import { inThreadSheetHost } from "../dom/sheet/host"
import { CORPUS_DIR } from "./corpusDir"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The corpus's workbooks with tables (structured references in their formulas): each formula written before dynamic
// arrays, typed again as shown (with the @ Excel shows), saves as it was. Opt-in (FILEN_OFFICE_SHEET_CORPUS=1).

const RUN = process.env["FILEN_OFFICE_SHEET_CORPUS"] === "1"
const DIR = join(CORPUS_DIR, "xlsx")
const FILES = RUN && existsSync(DIR) ? readdirSync(DIR).filter(name => name.endsWith(".xlsx")) : []
// Formula cells committed per workbook: the first of each shape.
const PER_WORKBOOK = 60

function sheetXml(bytes: Uint8Array): Map<string, string> {
	const files = unzipSync(bytes)

	return new Map(
		Object.entries(files)
			.filter(([name]) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
			.map(([name, data]) => [name, strFromU8(data)])
	)
}

// Whether a package holds a table part (a file that is no zip, an encrypted one, holds none to read).
function hasTables(bytes: Uint8Array): boolean {
	try {
		return Object.keys(unzipSync(bytes, { filter: file => file.name.startsWith("xl/tables/") })).length > 0
	} catch {
		return false
	}
}

describe.skipIf(!RUN || FILES.length === 0)("legacy formulas of the corpus's table workbooks", () => {
	it("typed again as shown, save as they were", async () => {
		const changed: string[] = []
		let committed = 0

		for (const name of FILES) {
			const bytes = new Uint8Array(readFileSync(join(DIR, name)))

			if (!hasTables(bytes)) continue

			const opened = await inThreadSheetHost().open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

			if (opened.kind !== "opened") continue

			const session = opened.session
			const document = (session as SheetSession<XlsxDocument>).document

			if ((await session.intent()).state !== "writable") {
				session.close()

				continue
			}

			const before = await session.save()

			if (!before.ok) throw new Error(`${name}: ${before.reason}`)

			const shapes = new Set<string>()

			for (const info of opened.info.sheets) {
				const model = await document.ready(info.id)
				const store = model.store as SheetStore

				for (const block of store.blocks) {
					if (block.formulas === null) continue

					for (let i = 0; i < block.rowCount && shapes.size < PER_WORKBOOK; i++) {
						for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
							const id = block.formulas[k] ?? -1

							if (id < 0) continue

							const kind = store.formulas.kind(id)

							if (kind === FormulaKind.ARRAY || kind === FormulaKind.DATA_TABLE) continue

							const row = block.firstRow + (block.rows[i] ?? 0)
							const col = block.cols[k] ?? 0
							const shown = document.shownFormulaText(model, id, row, col)
							const shape = shown.replace(/\d+/g, "")

							if (shapes.has(shape) || !shown.includes("[")) continue

							shapes.add(shape)

							const result = await session.command({
								type: "cells.set",
								sheet: info.id,
								cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [`=${shown}`] }
							})

							if (result.ok) committed++
						}
					}
				}
			}

			const after = await session.save()

			if (!after.ok) throw new Error(`${name}: ${after.reason}`)

			const was = sheetXml(before.bytes)

			for (const [part, xml] of sheetXml(after.bytes)) {
				const formulas = (text: string): string[] => [...text.matchAll(/<f\b[^>]*>[^<]*<\/f>/g)].map(match => match[0])

				if (formulas(xml).join("\n") !== formulas(was.get(part) ?? "").join("\n")) changed.push(`${name} ${part}`)
			}

			session.close()
		}

		expect(committed).toBeGreaterThan(0)
		expect(changed).toEqual([])
	}, 600_000)
})
