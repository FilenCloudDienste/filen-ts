import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import type { SheetCommand, SheetId } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import type { XlsxDocument } from "../core/xlsx/edit/document"
import { CORPUS_DIR } from "./corpusDir"
import { odsDocument, shownRows } from "./odsFixtures"
import { exportShown, sheetOffices, sheetProfile } from "./oracles/sheet/libreOffice"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Every corpus spreadsheet edited step by step (cells, formats, rows and columns inserted and deleted, a formula, a
// note, a validation, sheets added, renamed and moved), each step saved. Opt-in, twice over:
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: no save has an error its source does not (positions aside);
// - FILEN_OFFICE_SOFFICE=<soffice> naming a 7.5 install: LibreOffice opens every save, and where it shows the source
//   as we do, it shows each save as we do (CSV, as shown).
// Copies, saves and profiles go under FILEN_OFFICE_SHEET_LO_SCRATCH (default: the system temp directory).

const DIR = join(CORPUS_DIR, "ods")
const VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const OFFICE = sheetOffices().find(office => office.version.startsWith("7.5."))
const SCRATCH = process.env["FILEN_OFFICE_SHEET_LO_SCRATCH"] || tmpdir()
// Files up to this many bytes (FILEN_OFFICE_ODS_SAVE_LARGEST, default all): the largest take minutes in LibreOffice.
const LARGEST = Number(process.env["FILEN_OFFICE_ODS_SAVE_LARGEST"] ?? Number.POSITIVE_INFINITY)
const RULE = {
	type: "whole",
	operator: "between",
	value1: "1",
	value2: "100",
	allowBlank: true,
	inCellDropdown: true,
	showInputMessage: false,
	promptTitle: "",
	prompt: "",
	showErrorMessage: true,
	errorStyle: "stop",
	errorTitle: "",
	error: ""
} as const

function steps(sheet: SheetId, other: SheetId): SheetCommand[] {
	return [
		{ type: "cells.set", sheet, cells: { rows: Uint32Array.of(1, 2), cols: Uint16Array.of(1, 2), inputs: ["edited text", "12.5"] } },
		{
			type: "format.apply",
			sheet,
			ranges: [{ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }],
			patch: { bold: true, numFmt: "0.00", fill: 0xffff99 }
		},
		{ type: "axis.insert", sheet, axis: "rows", at: 3, count: 2 },
		{ type: "axis.delete", sheet, axis: "rows", at: 6, count: 1 },
		{ type: "axis.insert", sheet, axis: "cols", at: 1, count: 1 },
		{ type: "axis.delete", sheet, axis: "cols", at: 3, count: 1 },
		{ type: "cells.set", sheet, cells: { rows: Uint32Array.of(3), cols: Uint16Array.of(0), inputs: ["=SUM(B2:C3)"] } },
		{ type: "note.set", sheet, row: 0, col: 0, text: "A note\nwith two lines" },
		{ type: "validation.set", sheet, ranges: [{ startRow: 3, startCol: 3, endRow: 5, endCol: 3 }], rule: RULE },
		{ type: "sheet.add", name: "Added sheet" },
		{ type: "sheet.rename", sheet, name: "Renamed one" },
		{ type: "sheet.move", sheet: other, to: 0 }
	] as SheetCommand[]
}

interface Saved {
	source: string
	saves: string[]
}

async function saveSteps(name: string, work: string): Promise<Saved | null> {
	const bytes = new Uint8Array(readFileSync(join(DIR, name)))
	const opened = await inThreadSheetHost().open(
		bytes,
		{ kind: "ods", slicing: IMMEDIATE, settings: { author: "Oracle" } },
		() => undefined
	)

	if (opened.kind !== "opened") return null

	const session = opened.session

	try {
		if ((await session.intent()).state !== "writable") return null

		const document = (session as unknown as { document: XlsxDocument }).document
		const sheets = opened.info.sheets.filter(sheet => sheet.kind === "worksheet")
		const sheet = sheets.find(entry => document.model(entry.id)?.protection === null)?.id

		if (sheet === undefined) return null

		const stem = name.replace(/\.ods$/, "")
		const source = join(work, `${stem}.0.ods`)
		const saves: string[] = []

		writeFileSync(source, bytes)

		for (const command of steps(sheet, sheets.find(entry => entry.id !== sheet)?.id ?? sheet)) {
			if (!(await session.command(command)).ok) continue

			const saved = await session.save()

			if (!saved.ok) throw new Error(`${name}, ${command.type}: ${saved.message}`)

			const path = join(work, `${stem}.${saves.length + 1}.ods`)

			writeFileSync(path, saved.bytes)
			saves.push(path)
		}

		return { source, saves }
	} finally {
		session.close()
	}
}

// odfvalidator's kinds of error per file, as part and message: positions move with any edit, and a cell copied twice
// repeats its source's error rather than adding one.
function validatorErrors(files: readonly string[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>(files.map(file => [file, new Set()]))

	for (let start = 0; start < files.length; start += 100) {
		const batch = files.slice(start, start + 100)
		const run = spawnSync("java", ["-jar", VALIDATOR, ...batch], { encoding: "utf8", maxBuffer: 1 << 28 })

		// A spawn failure, a kill or a cut-off output reads as no error line, which would pass a save as adding none. A
		// non-zero exit is how odfvalidator reports an invalid file (sources among them), which the lines name.
		if (run.error !== undefined || run.signal !== null || run.status === null)
			throw new Error(
				`odfvalidator did not finish files ${start}-${start + batch.length - 1}: ${run.error?.message ?? run.signal ?? "no exit status"}`
			)

		for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
			const match = /^(.+?\.ods)(\/[^[:]*)?(?:\[\d+,\d+\])?:\s+(?:Error|Fatal):\s+(.*)$/.exec(line)
			const file = match === null ? undefined : batch.find(item => basename(item) === basename(match[1] ?? ""))

			if (match !== null && file !== undefined)
				out.get(file)?.add(`${match[2] ?? ""}: ${(match[3] ?? "").replace(/'file:[^']*'/g, "the package")}`)
		}
	}

	return out
}

async function ourShown(path: string): Promise<Map<string, string[][]> | null> {
	const result = await openOds(bytesSource(new Uint8Array(readFileSync(path))))

	if (!result.ok) return null

	const document = odsDocument(result)

	if (document.needsPreparing(false)) document.buildEngine()

	const out = new Map(result.workbook.sheets.map(entry => [entry.name, shownRows(document, entry.id)]))

	document.dropEngine()

	return out
}

function trimmed(rows: readonly (readonly string[])[]): string[][] {
	const out = rows.map(row => {
		const copy = [...row]

		while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop()

		return copy
	})

	while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop()

	return out
}

describe.skipIf(!existsSync(DIR) || (VALIDATOR === "" && OFFICE === undefined))(
	"ODS saves against odfvalidator and LibreOffice 7.5",
	() => {
		let work = ""
		const saved: Saved[] = []

		beforeAll(async () => {
			work = mkdtempSync(join(SCRATCH, "filen-office-ods-save-"))
			mkdirSync(join(work, "saves"))

			for (const name of readdirSync(DIR)
				.filter(file => file.endsWith(".ods"))
				.sort()) {
				if (readFileSync(join(DIR, name)).length > LARGEST) continue

				const result = await saveSteps(name, join(work, "saves"))

				if (result !== null) saved.push(result)
			}
		}, 3_600_000)

		afterAll(() => {
			if (work !== "") rmSync(work, { recursive: true, force: true })
		})

		it.skipIf(VALIDATOR === "")("adds no odfvalidator error to any save", { timeout: 3_600_000 }, () => {
			const errors = validatorErrors(saved.flatMap(item => [item.source, ...item.saves]))
			const added: string[] = []

			for (const item of saved) {
				const before = errors.get(item.source) ?? new Set<string>()

				for (const save of item.saves)
					for (const error of errors.get(save) ?? []) if (!before.has(error)) added.push(`${basename(save)}: ${error}`)
			}

			expect(saved.reduce((sum, item) => sum + item.saves.length, 0)).toBeGreaterThan(500)
			expect(added.slice(0, 20)).toEqual([])
		})

		it.skipIf(OFFICE === undefined)(
			"opens every save in LibreOffice, showing what we show wherever it shows the source so",
			{ timeout: 3_600_000 },
			async () => {
				const office = OFFICE

				if (office === undefined) return

				const files = saved.flatMap(item => [item.source, ...item.saves])
				const copies = files.map(file => {
					const copy = join(work, "copies", file.slice(join(work, "saves").length + 1))

					mkdirSync(join(work, "copies"), { recursive: true })
					copyFileSync(file, copy)

					return copy
				})
				const theirs = await exportShown(office, sheetProfile(work, "ods-save"), copies, join(work, "out"), 60_000, false)
				const byFile = new Map(files.map((file, index) => [file, theirs[index]]))
				const problems: string[] = []
				let compared = 0

				const same = async (file: string): Promise<boolean | string> => {
					const exported = byFile.get(file)

					if (exported?.ok !== true) return `LibreOffice cannot open it: ${exported?.error ?? "no export"}`

					const ours = await ourShown(file)

					if (ours === null) return "we cannot open it"

					return [...ours].every(([name, rows]) => {
						const sheet =
							exported.sheets.find(item => item.name === name) ??
							(exported.sheets.length === 1 && ours.size === 1 ? exported.sheets[0] : undefined)

						return sheet === undefined
							? /[/\\:*?"<>|]/.test(name)
							: JSON.stringify(rows) === JSON.stringify(trimmed(sheet.text))
					})
				}

				for (const item of saved) {
					const source = await same(item.source)

					for (const save of item.saves) {
						const result = await same(save)

						if (typeof result === "string") problems.push(`${basename(save)}: ${result}`)
						else if (source === true && !result) problems.push(`${basename(save)}: shown differently`)
						else if (source === true) compared++
					}
				}

				expect(problems.slice(0, 20)).toEqual([])
				expect(compared).toBeGreaterThan(400)
			}
		)
	}
)
