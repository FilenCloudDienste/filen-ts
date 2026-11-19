import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SheetSessionApi } from "../core/sheet/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { newValidityErrors, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { settle } from "./sheetNotesFixtures"
import { openCharts } from "./sheetChartFixtures"

// Every chart of the corpus's OOXML spreadsheets (in worksheets' drawings and on chartsheets): drawn (never failing), read for the editor, and edited (its legend),
// each save adding no schema error to the chart part. A workbook that does not open is counted with why; one whose
// opening throws fails. Opt-in (FILEN_OFFICE_SHEET_CORPUS=1, which needs the schema oracle);
// FILEN_OFFICE_CHART_REPORT names a file the tally and each file's time are written to.

const RUN = process.env["FILEN_OFFICE_SHEET_CORPUS"] === "1"
const KINDS = ["xlsx", "xlsm", "xltx", "xltm"] as const
// What openCharts throws for a workbook that did not open.
const UNOPENED = new Set(["failed", "aborted"])
// From a run over the corpus (85 workbooks, 1362 charts, 1330 edited), a little under it so a workbook or two may leave it.
const FLOOR = { files: 80, charts: 1250, edited: 1200 }

// The workbooks holding a chart part (one that is no zip holds none), listed only when the suite runs.
function workbooks(): string[] {
	return KINDS.flatMap(kind =>
		existsSync(join(CORPUS_DIR, kind)) ? readdirSync(join(CORPUS_DIR, kind)).map(name => join(CORPUS_DIR, kind, name)) : []
	).filter(path => {
		try {
			return Object.keys(unzipSync(readFileSync(path), { filter: file => /charts\/chart\d*\.xml$/.test(file.name) })).length > 0
		} catch {
			return false
		}
	})
}

interface Frame {
	readonly sheet: number
	readonly part: string
	readonly width: number
	readonly height: number
}

async function frames(session: SheetSessionApi, sheets: readonly number[]): Promise<Frame[]> {
	const out: Frame[] = []

	for (const sheet of sheets) {
		// A chartsheet's chart.
		const own = await session.query("chart.sheet", { sheet })

		if (own !== null) out.push({ sheet, part: own.part, width: own.width, height: own.height })

		await session.layout(sheet)
		await settle()

		for (const object of (await session.layout(sheet)).extensions?.drawings?.objects ?? []) {
			if (object.chartPart === undefined) continue

			const anchor = object.anchor
			const size = anchor.mode === "twoCell" ? { cx: 4_572_000, cy: 2_743_200 } : { cx: anchor.cx, cy: anchor.cy }

			out.push({ sheet, part: object.chartPart, width: size.cx, height: size.cy })
		}
	}

	return out
}

let oracle: XsdOracle | null = null

beforeAll(() => {
	oracle = RUN && xsdOracleMissing() === undefined ? new XsdOracle() : null
})

afterAll(() => {
	oracle?.dispose()
})

describe.skipIf(!RUN)("charts over the corpus", () => {
	it("draws, reads and edits every chart, adding no schema error", { timeout: 600_000 }, async () => {
		expect(oracle, xsdOracleMissing()).not.toBeNull()

		const tally = {
			files: 0,
			charts: 0,
			drawn: 0,
			unsupported: 0,
			editable: 0,
			edited: 0,
			refused: new Map<string, number>(),
			unopened: new Map<string, string>()
		}
		const times: [string, number][] = []
		const failures: string[] = []

		const report = process.env["FILEN_OFFICE_CHART_REPORT"]
		const write = (): void => {
			if (report !== undefined && report !== "")
				writeFileSync(
					report,
					JSON.stringify({ ...tally, refused: [...tally.refused], unopened: [...tally.unopened], times }, null, "\t")
				)
		}

		for (const path of workbooks()) {
			const started = performance.now()
			const source = new Uint8Array(readFileSync(path))
			let opened: Awaited<ReturnType<typeof openCharts>>

			try {
				opened = await openCharts(source)
			} catch (error) {
				if (error instanceof Error && UNOPENED.has(error.message)) tally.unopened.set(path, error.message)
				else failures.push(`${path}: opening threw ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)

				continue
			}

			tally.files++

			const { session, sheets } = opened
			const edited: string[] = []

			for (const frame of await frames(session, sheets)) {
				tally.charts++

				const drawn = await session.query("chart.render", { part: frame.part, width: frame.width, height: frame.height })

				expect(drawn.kind, `${path} ${frame.part}`).not.toBe("failed")
				if (drawn.kind === "drawing") tally.drawn++
				else tally.unsupported++

				const got = await session.query("chart.get", { sheet: frame.sheet, part: frame.part })

				if (got === null || got.refusal !== null) continue

				tally.editable++

				const result = await session.command({
					type: "chart.edit",
					sheet: frame.sheet,
					part: frame.part,
					edit: { kind: "legend", position: got.info.legend === "t" ? "b" : "t" }
				})

				if (!result.ok) {
					const key = `${result.refusal.reason}: ${result.refusal.detail ?? ""}`

					tally.refused.set(key, (tally.refused.get(key) ?? 0) + 1)

					continue
				}

				tally.edited++
				edited.push(frame.part)
			}

			// One save of every chart edited, each part against its source.
			if (edited.length > 0) {
				const saved = await session.save()

				expect(saved.ok, path).toBe(true)

				if (saved.ok && oracle !== null) {
					const sourceParts = unzipSync(source, { filter: file => edited.includes(file.name) })
					const savedParts = unzipSync(saved.bytes, { filter: file => edited.includes(file.name) })

					for (const part of edited) {
						const before = sourceParts[part]
						const after = savedParts[part]

						if (before === undefined || after === undefined) continue

						const [errorsBefore, errorsAfter] = oracle.validate([before, after])

						expect(newValidityErrors(errorsBefore ?? new Map(), errorsAfter ?? new Map(), before), `${path} ${part}`).toEqual(
							[]
						)
					}
				}
			}

			session.close()
			times.push([path.slice(path.lastIndexOf("/") + 1), Math.round(performance.now() - started)])
			write()
		}

		expect(failures).toEqual([])
		expect(tally.files, "workbooks opened").toBeGreaterThanOrEqual(FLOOR.files)
		expect(tally.charts, "charts").toBeGreaterThanOrEqual(FLOOR.charts)
		expect(tally.edited, "charts edited").toBeGreaterThanOrEqual(FLOOR.edited)
	})
})
