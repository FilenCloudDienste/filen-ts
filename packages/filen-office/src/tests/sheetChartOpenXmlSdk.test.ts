import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SheetCommand, SheetSessionApi } from "../core/sheet/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { settle } from "./sheetNotesFixtures"
import { buildFixture, cells } from "./sheetSessionFixtures"
import { CHART_PART, KEPT, SOLD, barChart, chartFixture, openCharts } from "./sheetChartFixtures"

// Charts edited, inserted and refreshed, saved and checked by the Open XML SDK validator (Microsoft365): a save adds
// no error to its source. Opt-in: FILEN_OFFICE_OOXML_VALIDATOR names the built validator, FILEN_OFFICE_DOTNET the
// dotnet host.

const MISSING = openXmlSdkMissing()

const edit = (sheet: number, change: Extract<SheetCommand, { type: "chart.edit" }>["edit"], part = CHART_PART): SheetCommand => ({
	type: "chart.edit",
	sheet,
	part,
	edit: change
})

const insert = (sheet: number, chart: Extract<SheetCommand, { type: "chart.insert" }>["chart"]): SheetCommand => ({
	type: "chart.insert",
	sheet,
	range: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
	chart,
	placement: { from: { row: 6, col: 0, rowOff: 0, colOff: 0 } }
})

const SCENARIOS: readonly { readonly name: string; readonly commands: (sheet: number) => SheetCommand[] }[] = [
	{
		name: "data",
		commands: sheet => [
			{
				type: "cells.set",
				sheet,
				cells: cells([
					[1, 1, "40"],
					[2, 0, "Quince"]
				])
			}
		]
	},
	{
		name: "every edit",
		commands: sheet => [
			edit(sheet, { kind: "type", plot: 0, type: "bar", grouping: "stacked" }),
			edit(sheet, { kind: "title", text: "Fruit" }),
			edit(sheet, { kind: "legend", position: "t" }),
			edit(sheet, {
				kind: "labels",
				plot: null,
				labels: { value: true, category: true, series: false, percent: false, position: "ctr" }
			}),
			edit(sheet, { kind: "axis", axis: 222, patch: { min: 0, max: 12, major: 3, format: "0.0", title: "Count", gridlines: false } }),
			edit(sheet, { kind: "series.add", plot: 0, name: "Extra", categories: "A2:A4", values: "C2:C4" }),
			edit(sheet, { kind: "series.move", series: 2, to: 0 }),
			edit(sheet, { kind: "series.remove", series: 1 })
		]
	},
	{ name: "pie", commands: sheet => [edit(sheet, { kind: "type", plot: 0, type: "doughnut" })] },
	{ name: "scatter", commands: sheet => [edit(sheet, { kind: "type", plot: 0, type: "scatter" })] },
	...(["column", "bar", "line", "area", "pie", "doughnut", "scatter"] as const).map(chart => ({
		name: `insert ${chart}`,
		commands: (sheet: number) => [insert(sheet, chart)]
	}))
]

async function saved(session: SheetSessionApi): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(result.message)

	return result.bytes
}

describe.skipIf(MISSING !== undefined)("charts against the Open XML SDK validator", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-openxml-chart-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("adds no error to a workbook whose charts were edited, inserted or refreshed", { timeout: 300_000 }, async () => {
		const source = join(scratch, "source.xlsx")
		const bytes = buildFixture(chartFixture(barChart([SOLD, KEPT])))

		writeFileSync(source, bytes)

		const before = sdkErrorCounts(await sdk.validate(source))

		for (const [index, scenario] of SCENARIOS.entries()) {
			const { session, sheets } = await openCharts(bytes)

			for (const command of scenario.commands(sheets[0] ?? 0)) expect((await session.command(command)).ok, scenario.name).toBe(true)

			const output = join(scratch, `${String(index)}.xlsx`)

			writeFileSync(output, await saved(session))
			session.close()

			const result = await sdk.validate(output)

			expect(result.fatal, scenario.name).toBeUndefined()
			expect(newSdkErrors(before, sdkErrorCounts(result), loadAllowlist()), scenario.name).toEqual([])
		}
	})

	// Corpus workbooks with charts of many kinds: every chart's legend moved, saved, nothing new.
	it.skipIf(!existsSync(join(CORPUS_DIR, "xlsx")))("adds no error to corpus charts it edits", { timeout: 300_000 }, async () => {
		const present = [
			"xlsx/poi__45544.xlsx",
			"xlsx/oxsdk__3D_Bar-O12-XL-Charts.xlsx",
			"xlsx/poi__45540_classic_Header.xlsx",
			"xlsx/xlsxwriter__chart_combined10.xlsx"
		].filter(relative => existsSync(join(CORPUS_DIR, relative)))

		expect(present.length, "none of the corpus chart workbooks is present").toBeGreaterThan(0)

		for (const relative of present) {
			const path = join(CORPUS_DIR, relative)

			const { session, sheets } = await openCharts(new Uint8Array(readFileSync(path)))
			let edited = 0

			for (const sheet of sheets) {
				await session.layout(sheet)
				// The drawings feature reads the sheet's drawing beside it.
				await settle()

				for (const object of (await session.layout(sheet)).extensions?.drawings?.objects ?? []) {
					if (object.chartPart === undefined) continue

					const result = await session.command(edit(sheet, { kind: "legend", position: "b" }, object.chartPart))

					if (result.ok) edited++
				}
			}

			const output = join(scratch, relative.replace("/", "-"))

			writeFileSync(output, await saved(session))
			session.close()

			const before = sdkErrorCounts(await sdk.validate(path))
			const after = await sdk.validate(output)

			expect(edited, relative).toBeGreaterThan(0)
			expect(after.fatal, relative).toBeUndefined()
			expect(newSdkErrors(before, sdkErrorCounts(after), loadAllowlist()), relative).toEqual([])
		}
	})
})
