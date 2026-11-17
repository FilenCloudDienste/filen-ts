import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CellFlag, type SheetLayout } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGridModel } from "../react/sheet/model"
import { BorderPainter } from "../react/sheet/paint/borders"
import { paintCells } from "../react/sheet/paint/cells"
import { paintChrome } from "../react/sheet/paint/chrome"
import { PatternCache } from "../react/sheet/paint/patterns"
import { TextMeasurer } from "../react/sheet/paint/text"
import { DEFAULT_THEME } from "../react/sheet/theme"
import { entryText } from "../react/sheet/tiles"
import { gridView, type GridView } from "../react/sheet/view"
import { CORPUS_DIR } from "./corpusDir"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The grid over every OOXML spreadsheet of the corpus: each sheet (up to three a file) is painted at its top and in
// the middle of its used area, and every plain one-line cell on screen draws its text exactly; nothing throws, and a
// frame's cost is reported. Opt-in (FILEN_OFFICE_SHEET_CORPUS=1).

const RUN = process.env["FILEN_OFFICE_SHEET_CORPUS"] === "1"
const KINDS = ["xlsx", "xlsm", "xltx", "xltm"] as const
const FILES = KINDS.flatMap(kind =>
	existsSync(join(CORPUS_DIR, kind))
		? readdirSync(join(CORPUS_DIR, kind)).map(name => ({ kind, path: join(CORPUS_DIR, kind, name) }))
		: []
)

async function settle(model: SheetGridModel, sheet: number, view: GridView): Promise<void> {
	const coordinates: number[] = []

	for (let row = Math.floor(view.rows.first / 64); row <= Math.floor(Math.max(view.rows.first, view.rows.last) / 64); row++)
		for (let col = Math.floor(view.cols.first / 32); col <= Math.floor(Math.max(view.cols.first, view.cols.last) / 32); col++)
			coordinates.push(row, col)

	for (let row = Math.floor(view.rows.frozenFirst / 64); view.rows.frozen > 0 && row <= Math.floor((view.rows.frozenEnd - 1) / 64); row++)
		for (let col = 0; col <= Math.floor(Math.max(view.cols.first, view.cols.last) / 32); col++) coordinates.push(row, col)

	model.need(sheet, coordinates)

	for (let k = 0; k < 4; k++) await new Promise(resolve => setTimeout(resolve, 0))
}

// Plain cells on screen whose text must be drawn as it is: one line, not turned, no repeat, not a number.
function plainTexts(model: SheetGridModel, sheet: number, view: GridView, layout: SheetLayout): string[] {
	const texts: string[] = []
	const merges = model.merges(layout)

	for (let row = view.rows.first; row <= view.rows.last; row++) {
		if (view.rows.axis.size(row) < 12) continue

		for (let col = view.cols.first; col <= view.cols.last; col++) {
			const found = model.entry(sheet, row, col)

			if (found === null || view.cols.axis.size(col) === 0) continue
			if (merges.some(merge => row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol)) continue

			const flags = found.tile.flags[found.entry] ?? 0
			const style = model.style(found.tile.styles[found.entry] ?? 0)
			const text = entryText(found.tile, found.entry)

			if (text === "" || /[\r\n]/u.test(text) || (flags & (CellFlag.NUMBER | CellFlag.REPEAT | CellFlag.RICH)) !== 0) continue
			if (
				style.wrap === true ||
				style.shrink === true ||
				(style.rotation ?? 0) !== 0 ||
				style.align === "fill" ||
				style.align === "justify" ||
				style.align === "distributed"
			)
				continue

			texts.push(text)
		}
	}

	return texts
}

describe.skipIf(!RUN || FILES.length === 0)("the grid over the corpus", () => {
	it("paints every sheet with its plain cells' texts", { timeout: 1_800_000 }, async () => {
		const host = inThreadSheetHost()
		const tally = { files: 0, sheets: 0, frames: 0, cells: 0, worst: 0, worstFile: "", failed: [] as string[] }

		for (const file of FILES) {
			const opened = await host.open(readFileSync(file.path), { kind: file.kind, slicing: IMMEDIATE }, () => undefined)

			if (opened.kind !== "opened") continue

			tally.files++

			const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })

			for (const summary of opened.info.sheets.filter(entry => entry.kind === "worksheet").slice(0, 3)) {
				model.setSheet(summary.id)

				let layout = model.layout(summary.id)

				if (layout === null) {
					layout = await opened.session.layout(summary.id)
					model.handleEvent({ type: "sheetReady", sheet: summary, layout })
				}

				const axes = model.axes(summary.id)

				if (axes === null) continue

				tally.sheets++

				for (const top of [0, Math.max(0, axes.rows.offset(Math.floor(layout.rowCount / 2)))]) {
					const view = gridView(axes, layout, { top, left: 0 }, 1600, 900)
					const canvas = new RecordingCanvas()

					await settle(model, summary.id, view)

					// A second frame, warm (the first measures text and compiles the painter).
					let cost = 0

					for (let pass = 0; pass < 2; pass++) {
						canvas.reset()

						const started = performance.now()

						paintCells(
							{
								canvas,
								measurer: new TextMeasurer(canvas),
								borders: new BorderPainter(canvas),
								patterns: new PatternCache(() => null)
							},
							{ model, sheet: summary.id, layout, view, theme: DEFAULT_THEME, scale: axes.scale, pixelRatio: 1 }
						)
						paintChrome(canvas, {
							view,
							theme: DEFAULT_THEME,
							pixelRatio: 1,
							selection: model.getSnapshot().selection,
							merges: model.merges(layout),
							guide: null
						})
						cost = performance.now() - started
					}

					if (cost > tally.worst) tally.worstFile = `${file.path} #${String(summary.id)}`

					tally.worst = Math.max(tally.worst, cost)
					tally.frames++

					const drawn = new Set(canvas.texts())

					for (const text of plainTexts(model, summary.id, view, layout)) {
						tally.cells++

						if (!drawn.has(text)) tally.failed.push(`${file.path} #${String(summary.id)}: ${text.slice(0, 40)}`)
					}
				}
			}

			opened.session.close()
		}

		console.log(
			`grid corpus: ${String(tally.files)} files, ${String(tally.sheets)} sheets, ${String(tally.frames)} frames, ${String(tally.cells)} plain cells, worst frame ${tally.worst.toFixed(1)} ms (${tally.worstFile})`
		)
		expect(tally.failed.slice(0, 20)).toEqual([])
	})
})
