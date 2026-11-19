import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openXlsxSession } from "../core/sheet/commands"
import type { SheetCommandResult } from "../core/sheet/protocol"
import { compareRecords, modelRecord, readSaved } from "./fuzz/sheet/compare"
import { fixtureBytes } from "./fuzz/sheet/fixtures"
import { DEFAULT_SEQUENCE, runSequence } from "./fuzz/sheet/harness"

// The sheet fuzz reads back the worksheet sections its ops edit beyond cells (data validations, the autoFilter,
// hyperlinks), and reads its source once per sequence.

const reads = vi.hoisted(() => ({ sources: [] as Uint8Array[] }))

vi.mock("./fuzz/sheet/compare", async original => {
	const actual = await original<typeof import("./fuzz/sheet/compare")>()

	return {
		...actual,
		readSaved: (bytes: Uint8Array, source?: Parameters<typeof actual.readSaved>[1]) => {
			reads.sources.push(bytes)

			if (source instanceof Uint8Array) reads.sources.push(source)

			return actual.readSaved(bytes, source)
		}
	}
})

const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }
const RULE = {
	type: "whole",
	operator: "between",
	value1: "1",
	value2: "10",
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

function applied(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)
}

// The save with `pattern` taken out of every worksheet part.
function without(bytes: Uint8Array, pattern: RegExp): Uint8Array {
	const files = unzipSync(bytes)

	for (const name of Object.keys(files))
		if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) files[name] = strToU8(strFromU8(files[name] as Uint8Array).replace(pattern, ""))

	return zipSync(files)
}

describe("sheet fuzz read-back", () => {
	it("compares data validations, the autoFilter and hyperlinks with the model", { timeout: 60_000 }, async () => {
		const opened = await openXlsxSession(
			bytesSource(fixtureBytes("rich")),
			{ kind: "xlsx", slicing: IMMEDIATE, settings: { author: "Fuzz", clock: () => 0 } },
			() => undefined
		)

		if (opened.kind !== "opened") throw new Error(`expected an open, got ${opened.kind}`)

		const session = opened.session

		try {
			await session.document.readyAllSheets(IMMEDIATE)

			const sheet = session.document.worksheets()[0]?.id ?? 0

			applied(
				await session.command({
					type: "validation.set",
					sheet,
					ranges: [
						{ startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
						{ startRow: 8, startCol: 4, endRow: 9, endCol: 4 }
					],
					rule: RULE
				})
			)
			applied(
				await session.command({
					type: "filter.toggle",
					sheet,
					range: { startRow: 0, startCol: 0, endRow: 9, endCol: 2 },
					active: { row: 0, col: 0 }
				})
			)
			applied(
				await session.command({
					type: "link.set",
					sheet,
					ranges: [{ startRow: 12, startCol: 1, endRow: 12, endCol: 1 }],
					target: { url: "https://example.com/" }
				})
			)

			const saved = await session.save()

			if (!saved.ok) throw new Error(`${saved.reason}: ${saved.message}`)

			const model = modelRecord(session.document.workbook)
			const record = model.sheets[0]

			expect(record?.validations).toEqual(["0,0:3,1 8,4:9,4"])
			expect(record?.autoFilter).toBe("0,0:9,2")
			expect(record?.links).toEqual(["12,1:12,1"])
			expect(compareRecords(model, await readSaved(saved.bytes))).toEqual([])

			const dropped = (pattern: RegExp): Promise<string[]> =>
				readSaved(without(saved.bytes, pattern)).then(actual => compareRecords(model, actual))

			expect(await dropped(/<dataValidations\b[\s\S]*?<\/dataValidations>/)).toEqual([
				"Data dataValidations: missing 0,0:3,1 8,4:9,4"
			])
			expect(await dropped(/<autoFilter\b[^>]*?(?:\/>|>[\s\S]*?<\/autoFilter>)/)).toEqual(["Data autoFilter: 0,0:9,2≠∅"])
			expect(await dropped(/<hyperlinks\b[\s\S]*?<\/hyperlinks>/)).toEqual(["Data hyperlinks: missing 12,1:12,1"])
		} finally {
			session.close()
		}
	})

	it("reads the source once per sequence", { timeout: 120_000 }, async () => {
		const bytes = fixtureBytes("rich")

		reads.sources.length = 0

		const result = await runSequence(bytes, "xlsx", "rich", 3, "sync", { ...DEFAULT_SEQUENCE, edges: false, ranges: false })

		expect(result.checks).toBeGreaterThan(2)
		expect(reads.sources.filter(read => read === bytes)).toHaveLength(1)
	})
})
