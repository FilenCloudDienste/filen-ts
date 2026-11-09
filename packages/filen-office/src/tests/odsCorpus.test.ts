import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOds } from "../core/ods/open"
import { HeldResult } from "../core/sheet/formula/formulaEngine"
import { cellKeyOf } from "../core/xlsx/edit/history"
import type { SheetStore } from "../core/xlsx/model/store"
import { CellKind } from "../core/xlsx/model/types"
import { CORPUS_DIR } from "./corpusDir"
import { odsDocument } from "./odsFixtures"

// The licensed corpus's spreadsheets: every one opens (an encrypted one is refused, as LibreOffice asks for its
// password), and its formulas, built into the engine as a session builds them, give the results LibreOffice cached.

const DIR = join(CORPUS_DIR, "ods")
const FILES = existsSync(DIR)
	? readdirSync(DIR)
			.filter(name => name.endsWith(".ods"))
			.sort()
	: []
// The encrypted files, in name order.
const ENCRYPTED = ["lo__password.ods", "lo__passwordOld.ods"]
// A LibreOffice sheet whose table style writes right to left.
const RTL = "lo__tdf137081_RTL_page_anchored.ods"
// Large files are left to the performance bench: the engine over their tens of thousands of formulas takes long here.
const ENGINE_LIMIT = 4 * 1024 * 1024
// Files whose cached results differ from what the engine calculates, and why.
const ACCEPTED: Readonly<Record<string, string>> = {
	// ODF 1.3 Part 4 §6.3.14 converts a number to text in the evaluator's locale (HOST-LOCALE): the cache holds an
	// it-IT author's "2,5A" and "#VALORE!"; LibreOffice 7.5 recalculating under en-US gives our "2.5A" and "#VALUE!".
	"lo__tdf132278.ods": "the cache was calculated in the author's it-IT locale"
}

describe.skipIf(FILES.length === 0)("ODS corpus", () => {
	it("opens every file but the encrypted ones, which are refused with their reason", { timeout: 600_000 }, async () => {
		const failures: string[] = []

		for (const name of FILES) {
			const result = await openOds(bytesSource(new Uint8Array(readFileSync(join(DIR, name)))))

			if (!result.ok) failures.push(`${name}: ${result.reason}`)
		}

		// AES-256-CBC (ODF 1.2+) and the legacy Blowfish CFB of OpenOffice.org 1.x-3.x packages alike.
		expect(failures).toEqual(ENCRYPTED.filter(name => FILES.includes(name)).map(name => `${name}: encrypted`))
	})

	it.skipIf(!FILES.includes(RTL))("opens a right-to-left sheet (style:writing-mode rl-tb) mirrored", async () => {
		const result = await openOds(bytesSource(new Uint8Array(readFileSync(join(DIR, RTL)))))

		if (!result.ok) throw new Error(result.reason)

		expect(result.workbook.sheets.map(sheet => sheet.model?.view.rightToLeft)).toEqual([true])
	})

	it(
		"calculates what LibreOffice cached for at least 99 % of the formulas, any other held or accepted",
		{ timeout: 600_000 },
		async () => {
			let formulas = 0
			let passed = 0
			let held = 0
			// Volatile formulas, and results the file marks as errors with no error value: recalculated on load, as
			// LibreOffice does, so not compared with the cache.
			let recalculated = 0
			const mismatched = new Set<string>()

			for (const name of FILES) {
				const path = join(DIR, name)

				if (statSync(path).size > ENGINE_LIMIT) continue

				const result = await openOds(bytesSource(new Uint8Array(readFileSync(path))))

				if (!result.ok) continue

				formulas += result.issues.filter(issue => issue.kind === "formula").reduce((sum, issue) => sum + issue.count, 0)

				const document = odsDocument(result)
				const engine = document.buildEngine()

				document.engineSheets.forEach((id, index) => {
					const model = document.model(id)

					if (model === null) return

					for (const block of (model.store as SheetStore).blocks) {
						for (let i = 0; i < block.rowCount; i++) {
							const row = block.firstRow + (block.rows[i] ?? 0)

							for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
								if ((block.formulas?.[k] ?? -1) < 0) continue

								const col = block.cols[k] ?? 0

								formulas++

								if (document.engineCell(model, row, col).content instanceof HeldResult) {
									held++

									continue
								}

								if (model.recalculate?.has(cellKeyOf(row, col)) === true) {
									recalculated++

									continue
								}

								const got = engine.result(index, row, col)
								const kind = block.kinds[k]
								const value = block.values[k] ?? 0

								if (
									(kind === CellKind.NUMBER &&
										typeof got.value === "number" &&
										Math.abs(got.value - value) <= 1e-9 * Math.max(1, Math.abs(value))) ||
									(kind === CellKind.BOOLEAN && (got.value === (value === 1) || got.value === value)) ||
									((kind === CellKind.INLINE_STRING || kind === CellKind.SHARED_STRING) &&
										String(got.value ?? "") === document.stringOf(model, kind, value)) ||
									(kind === CellKind.ERROR &&
										(got.error === true || String(got.value) === document.stringOf(model, kind, value)))
								) {
									passed++
								} else mismatched.add(name)
							}
						}
					}
				})
				document.dropEngine()
			}

			expect(formulas).toBeGreaterThan(5000)
			expect(passed / formulas).toBeGreaterThanOrEqual(0.99)
			expect(held + recalculated).toBeLessThan(formulas / 100)
			expect([...mismatched].filter(name => ACCEPTED[name] === undefined)).toEqual([])
		}
	)
})
