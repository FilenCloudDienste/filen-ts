// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { tileKey } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGrid, SheetGridModel, toDom, type SheetGridHandle } from "../react/sheet/index"
import { bodyTotal } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE, SML, buildFixture } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"

// The grid's main-thread budgets at 1M cells (100k rows by 10 columns) on the in-thread host, the draw calls going
// to a recording context (the browser's raster is measured apart): a scroll frame's script under 50 ms (no long
// task), a tile missed by a frame drawn by the frame after the session's answer, and a keystroke's commit drawn
// within 16 ms at the 95th percentile. Opt-in (FILEN_OFFICE_SHEET_PERF=1): the workbook is built in the test.

const PERF =
	(Reflect.get(globalThis, "process") as { env: Record<string, string | undefined> } | undefined)?.env["FILEN_OFFICE_SHEET_PERF"] === "1"
const ROWS = 100_000
const COLS = 10

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

function bigWorkbook(): Uint8Array {
	const rows: string[] = []

	for (let row = 1; row <= ROWS; row++) {
		let markup = `<row r="${String(row)}">`

		for (let col = 0; col < COLS; col++) {
			const reference = `${String.fromCharCode(65 + col)}${String(row)}`

			markup +=
				col === 0
					? `<c r="${reference}" t="s"><v>${String(row % 100)}</v></c>`
					: `<c r="${reference}"><v>${String((row * COLS + col) / 7)}</v></c>`
		}

		rows.push(`${markup}</row>`)
	}

	const strings = Array.from({ length: 100 }, (_, k) => `<si><t>text ${String(k)}</t></si>`).join("")

	return buildFixture({
		sheets: [{ name: "Big", body: `<dimension ref="A1:J${String(ROWS)}"/><sheetData>${rows.join("")}</sheetData>` }],
		sharedStrings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="${String(ROWS)}" uniqueCount="100">${strings}</sst>`
	})
}

function percentile(values: readonly number[], share: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0
}

async function macrotask(): Promise<void> {
	await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

describe.skipIf(!PERF)("grid budgets at 1M cells", () => {
	it(
		"scrolls without long tasks, fills missed tiles a frame after the answer, and draws a commit within a frame",
		{ timeout: 600_000 },
		async () => {
			vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
				() => new RecordingCanvas() as unknown as CanvasRenderingContext2D
			)
			vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
				return this.classList.contains("fo-sheet-scroller") ? 1600 : 0
			})
			vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
				return this.classList.contains("fo-sheet-scroller") ? 900 : 0
			})

			const host = inThreadSheetHost()
			const opened = await host.open(bigWorkbook(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

			if (opened.kind !== "opened") throw new Error(opened.kind)

			const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })
			const ref = createRef<SheetGridHandle>()
			const container = document.createElement("div")
			const root = createRoot(container)

			document.body.appendChild(container)
			await act(async () => {
				root.render(
					<SheetGrid
						ref={ref}
						grid={model}
						label="Sheet"
						editorLabel="Entry"
					/>
				)
			})

			const handle = ref.current as SheetGridHandle
			const scroller = container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement
			const renderer = handle.renderer
			const sheet = opened.info.activeSheet
			const paint = (): number => {
				const started = cpuMs()

				renderer.paint()

				return cpuMs() - started
			}

			paint()
			await macrotask()
			paint()

			// Scrolling: page steps down the sheet, then jumps across it.
			const frames: number[] = []
			const fills: number[] = []
			const positions: number[] = []

			for (let step = 0; step < 150; step++) positions.push(step * 700)
			for (let jump = 0; jump < 150; jump++) positions.push(((jump * 7919) % 997) * 2000)

			for (const top of positions) {
				const view = renderer.currentView()

				if (view === null) throw new Error("no view")

				scroller.scrollTop = toDom(top, bodyTotal(view.rows), view.rows.bodyView)
				scroller.dispatchEvent(new Event("scroll"))
				frames.push(paint())

				const shown = renderer.currentView()

				if (shown === null) throw new Error("no view")

				const needed = tileKey(sheet, Math.floor(shown.rows.first / 64), 0)

				if (!model.tiles.has(needed)) {
					// Missed: the session answers in a macrotask; the next frame draws it.
					const asked = cpuMs()

					await macrotask()
					frames.push(paint())
					fills.push(cpuMs() - asked)

					expect(model.tiles.has(needed)).toBe(true)
				}
			}

			// Keystrokes: a digit typed into a cell, then Enter; the commit's frame drawn at once (the entry shows before
			// the session answers).
			const commits: number[] = []

			for (let k = 0; k < 100; k++) {
				act(() => handle.goTo({ row: 50 + k, col: 3 }))
				paint()
				act(() => {
					scroller.dispatchEvent(new KeyboardEvent("keydown", { key: String(k % 10), bubbles: true, cancelable: true }))
				})

				const editor = container.querySelector("textarea") as HTMLTextAreaElement
				const started = cpuMs()

				act(() => {
					editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
				})
				renderer.paint()
				commits.push(cpuMs() - started)
				await macrotask()
			}

			const report = {
				scrollFrameP95: percentile(frames, 0.95),
				scrollFrameMax: Math.max(...frames),
				tileMisses: fills.length,
				missFillP95: percentile(fills, 0.95),
				commitP95: percentile(commits, 0.95),
				commitMax: Math.max(...commits),
				cachedTiles: model.tiles.size
			}

			console.log(`grid perf: ${JSON.stringify(report)}`)
			expect(report.scrollFrameMax).toBeLessThan(budget(50))
			expect(report.commitP95).toBeLessThanOrEqual(budget(16))
			expect(report.cachedTiles).toBeLessThanOrEqual(24)

			act(() => root.unmount())
		}
	)
})
