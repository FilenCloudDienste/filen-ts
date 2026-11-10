// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetEvent } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGrid, SheetGridModel, type SheetGridHandle } from "../react/sheet/index"
import type { SheetKeyBindings, SheetShortcut } from "../react/sheet/keys"
import { RecordingCanvas } from "./sheetGridCanvas"
import { sheetBody } from "./sheetKeysFixtures"
import { IMMEDIATE, buildFixture, firstTile, tileEntry } from "./sheetSessionFixtures"
import { STYLES } from "./xlsxWriteFixtures"

// The grid's keyboard shortcuts on the in-thread host: fills, selections, entries, formats, sheets and the ones it
// hands the app.

const canvases = new WeakMap<HTMLCanvasElement, RecordingCanvas>()

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		let canvas = canvases.get(this)

		if (canvas === undefined) {
			canvas = new RecordingCanvas()
			canvases.set(this, canvas)
		}

		return canvas as unknown as CanvasRenderingContext2D
	} as unknown as typeof HTMLCanvasElement.prototype.getContext)
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 800 : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 400 : 0
	})
})

const roots: Root[] = []

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
})

async function settle(): Promise<void> {
	for (let k = 0; k < 8; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

interface Mounted {
	readonly model: SheetGridModel
	readonly handle: SheetGridHandle
	readonly scroller: HTMLElement
	readonly shortcuts: SheetShortcut[]
}

// Column A: 1, 2, 3, then blank, then 10; B1 "x". Two sheets.
const BOOK = {
	sheets: [
		{ name: "One", body: sheetBody([[1, "x"], [2], [3], [], [10]]) },
		{ name: "Two", body: sheetBody([["two"]]) }
	]
}

async function mount(
	fixture: Parameters<typeof buildFixture>[0] | string = BOOK,
	options: { readonly mac?: boolean; readonly take?: readonly SheetShortcut[]; readonly bindings?: SheetKeyBindings } = {}
): Promise<Mounted> {
	const host = inThreadSheetHost()
	// Events before the model exists wait for it, as an app hands them over from the open on.
	const early: SheetEvent[] = []
	let target: SheetGridModel | null = null
	const csv = typeof fixture === "string"
	const bytes = csv ? new TextEncoder().encode(fixture) : buildFixture(fixture)
	const opened = await host.open(bytes, { kind: csv ? "csv" : "xlsx", slicing: IMMEDIATE }, event => {
		if (target === null) early.push(event)
		else target.handleEvent(event)
	})

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ session: opened.session, info: opened.info })

	target = model

	for (const event of early.splice(0)) model.handleEvent(event)
	const container = document.createElement("div")
	const ref = createRef<SheetGridHandle>()
	const root = createRoot(container)
	const shortcuts: SheetShortcut[] = []

	roots.push(root)
	document.body.appendChild(container)
	await act(async () => {
		root.render(
			<SheetGrid
				ref={ref}
				grid={model}
				label="Sheet"
				editorLabel="Cell entry"
				mac={options.mac ?? false}
				{...(options.bindings !== undefined && { bindings: options.bindings })}
				onShortcut={shortcut => {
					shortcuts.push(shortcut)

					return options.take?.includes(shortcut) === true
				}}
			/>
		)
	})
	await settle()
	act(() => ref.current?.renderer.paint())
	await settle()

	return {
		model,
		handle: ref.current as SheetGridHandle,
		scroller: container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement,
		shortcuts
	}
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	act(() => {
		target.dispatchEvent(event)
	})

	return event
}

async function text(model: SheetGridModel, row: number, col: number, sheet = 0): Promise<string | undefined> {
	return tileEntry(await firstTile(model.session, sheet), row, col)?.text
}

describe("grid shortcuts", () => {
	it("fills down with Ctrl+D, and a one-row selection takes the row above", async () => {
		const { model, scroller } = await mount()

		act(() =>
			model.select({
				active: { row: 0, col: 0 },
				anchor: { row: 0, col: 0 },
				focus: { row: 2, col: 1 },
				ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 1 }]
			})
		)
		expect(key(scroller, { key: "d", code: "KeyD", ctrlKey: true }).defaultPrevented).toBe(true)
		await settle()

		expect(await text(model, 2, 0)).toBe("1")
		expect(await text(model, 2, 1)).toBe("x")

		act(() =>
			model.select({
				active: { row: 4, col: 1 },
				anchor: { row: 4, col: 1 },
				focus: { row: 4, col: 1 },
				ranges: [{ startRow: 4, startCol: 1, endRow: 4, endCol: 1 }]
			})
		)
		key(scroller, { key: "d", code: "KeyD", ctrlKey: true })
		await settle()

		// B4 is blank: B5 takes it, empty.
		expect(await text(model, 4, 1)).toBeUndefined()
	})

	it("fills right with Command+R on a Mac", async () => {
		const { model, scroller } = await mount(BOOK, { mac: true })

		act(() =>
			model.select({
				active: { row: 1, col: 0 },
				anchor: { row: 1, col: 0 },
				focus: { row: 1, col: 2 },
				ranges: [{ startRow: 1, startCol: 0, endRow: 1, endCol: 2 }]
			})
		)
		key(scroller, { key: "r", code: "KeyR", metaKey: true })
		await settle()

		expect(await text(model, 1, 2)).toBe("2")
	})

	it("jumps to the data region's edge with Ctrl+arrow and extends there with Shift", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "ArrowDown", code: "ArrowDown", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 0 })

		key(scroller, { key: "ArrowDown", code: "ArrowDown", ctrlKey: true, shiftKey: true })
		await settle()
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 2, startCol: 0, endRow: 4, endCol: 0 }])
	})

	// The page's own keys listen on the document (an audio player's Ctrl+Shift+Arrow skip): a move is the grid's alone.
	it("keeps a move's key from the page around the grid", async () => {
		const { scroller } = await mount()
		const page = vi.fn()

		document.addEventListener("keydown", page)
		key(scroller, { key: "ArrowRight", code: "ArrowRight", ctrlKey: true, shiftKey: true })
		document.removeEventListener("keydown", page)

		expect(page).not.toHaveBeenCalled()
	})

	// Safari sends an input method's confirming Enter with keyCode 229: an entry for the composition, never a move.
	it("opens an entry for an input method's key that reads as a shortcut, and runs none", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "Enter", code: "Enter", keyCode: 229 })
		await settle()

		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })
		expect(document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor")?.value).toBe("")
	})

	it("selects the data region with Ctrl+A, then the whole sheet", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "a", code: "KeyA", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 1 }])

		key(scroller, { key: "a", code: "KeyA", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().selection.ranges).toEqual([
			{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
		])
	})

	it("selects whole columns with Ctrl+Space and whole rows with Shift+Space", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: " ", code: "Space", ctrlKey: true })
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 }])

		key(scroller, { key: " ", code: "Space", shiftKey: true })
		expect(model.getSnapshot().selection.ranges).toEqual([
			{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
		])
	})

	it("starts an entry with today's date (Ctrl+;) and fills a selection with an entry (Ctrl+Enter)", async () => {
		const { model, scroller } = await mount()

		act(() =>
			model.select({
				active: { row: 6, col: 0 },
				anchor: { row: 6, col: 0 },
				focus: { row: 7, col: 1 },
				ranges: [{ startRow: 6, startCol: 0, endRow: 7, endCol: 1 }]
			})
		)
		key(scroller, { key: ";", code: "Semicolon", ctrlKey: true })

		expect(model.getSnapshot().editing?.text).toMatch(/^\d{4}-\d{2}-\d{2}$/)

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		act(() => model.setEditText("=A1*2"))
		key(editor, { key: "Enter", ctrlKey: true })
		await settle()

		const tile = await firstTile(model.session, 0)

		expect(tileEntry(tile, 6, 0)?.input).toBe("=A1*2")
		expect(tileEntry(tile, 7, 1)?.input).toBe("=B2*2")
		expect(model.getSnapshot().editing).toBeNull()
	})

	it("cycles the reference at the caret through absolute and relative with F4 while a formula is typed", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "F2", code: "F2" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		act(() => model.setEditText("=SUM(B1:C2)"))
		editor.setSelectionRange(9, 9)

		const first = key(editor, { key: "F4", code: "F4" })

		expect(first.defaultPrevented).toBe(true)
		expect(model.getSnapshot().editing?.text).toBe("=SUM($B$1:$C$2)")
		expect(editor.selectionEnd).toBe(14)

		key(editor, { key: "F4", code: "F4" })
		expect(model.getSnapshot().editing?.text).toBe("=SUM(B$1:C$2)")
		// Typed text is no reference: nothing changes, and no command repeats.
		act(() => model.setEditText("hello"))
		key(editor, { key: "F4", code: "F4" })
		await settle()
		expect(model.getSnapshot().editing?.text).toBe("hello")
	})

	it("applies a format with Ctrl+B and repeats it elsewhere with F4", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "b", code: "KeyB", ctrlKey: true })
		await settle()

		const bold = (row: number, col: number): boolean => {
			const found = model.entry(0, row, col)

			return found !== null && model.style(found.tile.styles[found.entry] ?? 0).bold === true
		}

		expect(bold(0, 0)).toBe(true)

		key(scroller, { key: "ArrowDown", code: "ArrowDown" })
		key(scroller, { key: "F4", code: "F4" })
		await settle()

		expect(bold(1, 0)).toBe(true)

		key(scroller, { key: "$", code: "Digit4", ctrlKey: true, shiftKey: true })
		await settle()

		expect(await text(model, 1, 0)).toBe("$2.00 ")
	})

	it("repeats a merge with F4 without the consent to lose values given for the first one", async () => {
		const { model, scroller } = await mount()
		const refused: unknown[] = []

		model.setRefusalHandler((refusal, command) => refused.push([refusal.reason, command]))

		// A3:B3 merged once the user agreed that values outside A3 go.
		const merged = await model.command({
			type: "merge.cells",
			sheet: 0,
			ranges: [{ startRow: 2, startCol: 0, endRow: 2, endCol: 1 }],
			mode: "merge",
			discard: true
		})

		expect(merged.ok).toBe(true)

		model.select({
			ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
			active: { row: 0, col: 0 },
			anchor: { row: 0, col: 0 },
			focus: { row: 0, col: 1 }
		})
		key(scroller, { key: "F4", code: "F4" })
		await settle()

		// B1's "x" stays, and the app hears the merge it must ask about.
		expect(await text(model, 0, 1)).toBe("x")
		expect(refused).toEqual([
			[
				"mergeLosesValues",
				{ type: "merge.cells", sheet: 0, ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }], mode: "merge" }
			]
		])
	})

	it("goes to the next sheet with Ctrl+Page Down and back with Ctrl+Page Up", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "PageDown", code: "PageDown", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().sheet).toBe(1)

		key(scroller, { key: "PageUp", code: "PageUp", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().sheet).toBe(0)
	})

	it("goes to the next sheet with Ctrl+Alt+Page Down and back with Ctrl+Alt+Page Up, as Excel for the web in Chrome", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "PageDown", code: "PageDown", ctrlKey: true, altKey: true })
		await settle()
		expect(model.getSnapshot().sheet).toBe(1)

		key(scroller, { key: "PageUp", code: "PageUp", ctrlKey: true, altKey: true })
		await settle()
		expect(model.getSnapshot().sheet).toBe(0)
	})

	it("takes Ctrl+Minus and Ctrl+Shift+Plus on cells from the page, handing them to the app", async () => {
		const { scroller, shortcuts } = await mount()
		const minus = key(scroller, { key: "-", code: "Minus", ctrlKey: true })
		const plus = key(scroller, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })

		// Not the browser's zoom.
		expect([minus.defaultPrevented, plus.defaultPrevented]).toEqual([true, true])
		expect(shortcuts).toEqual(["deleteCells", "insertCells"])
	})

	it("reads Ctrl+Z by the key's position on a layout that types no Latin letter there", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "b", code: "KeyB", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().state.canUndo).toBe(true)

		// Russian: "я" sits on QWERTY's "z".
		const undo = key(scroller, { key: "я", code: "KeyZ", ctrlKey: true })

		await settle()
		expect(undo.defaultPrevented).toBe(true)
		expect(model.getSnapshot().state.canUndo).toBe(false)
	})

	it("inserts and deletes whole rows with Ctrl+Shift+Plus and Ctrl+Minus", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: " ", code: "Space", shiftKey: true })
		key(scroller, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })
		await settle()
		expect(await text(model, 1, 0)).toBe("1")

		key(scroller, { key: "-", code: "Minus", ctrlKey: true })
		await settle()
		expect(await text(model, 0, 0)).toBe("1")
	})

	it("deletes every selected run of whole rows with Ctrl+Minus, undone in one step", async () => {
		const { model, scroller } = await mount()
		const row = (at: number) => ({ startRow: at, startCol: 0, endRow: at, endCol: SHEET_MAX_COLS - 1 })

		act(() =>
			model.select({
				active: { row: 2, col: 0 },
				anchor: { row: 2, col: 0 },
				focus: { row: 2, col: SHEET_MAX_COLS - 1 },
				ranges: [row(0), row(2)]
			})
		)
		key(scroller, { key: "-", code: "Minus", ctrlKey: true })
		await settle()
		expect([await text(model, 0, 0), await text(model, 2, 0)]).toEqual(["2", "10"])

		key(scroller, { key: "z", code: "KeyZ", ctrlKey: true })
		await settle()
		expect([await text(model, 0, 0), await text(model, 2, 0), await text(model, 4, 0)]).toEqual(["1", "3", "10"])
	})

	it("refuses Ctrl+Minus on whole rows selected with whole columns, as Excel's multiple selections", async () => {
		const { model, scroller } = await mount()
		const refused: string[] = []

		model.setRefusalHandler(refusal => refused.push(`${refusal.reason}:${refusal.detail ?? ""}`))
		act(() =>
			model.select({
				active: { row: 0, col: 1 },
				anchor: { row: 0, col: 1 },
				focus: { row: SHEET_MAX_ROWS - 1, col: 1 },
				ranges: [
					{ startRow: 0, startCol: 0, endRow: 0, endCol: SHEET_MAX_COLS - 1 },
					{ startRow: 0, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 1 }
				]
			})
		)
		key(scroller, { key: "-", code: "Minus", ctrlKey: true })
		await settle()
		expect(refused).toEqual(["multipleSelection:mixed"])
		expect(await text(model, 0, 0)).toBe("1")
		expect(model.getSnapshot().state.canUndo).toBe(false)
	})

	it("shows formulas in their cells with Ctrl+`, and results again with a second press", async () => {
		const { model, scroller, handle } = await mount({ sheets: [{ name: "One", body: sheetBody([[2, { f: "A1*3", v: 6 }]]) }] })
		const cells = canvases.get(scroller.parentElement?.querySelector("canvas") as HTMLCanvasElement) as RecordingCanvas
		// What was drawn since the last look (a frame with nothing new leaves the cells as drawn).
		const drawn = (): string[] => {
			act(() => handle.renderer.paint())

			const texts = cells.texts()

			cells.reset()

			return texts
		}

		expect(drawn()).toContain("6")

		key(scroller, { key: "`", code: "Backquote", ctrlKey: true })
		expect(model.getSnapshot().showFormulas).toBe(true)
		expect(drawn()).toContain("=A1*3")

		key(scroller, { key: "`", code: "Backquote", ctrlKey: true })
		expect(model.getSnapshot().showFormulas).toBe(false)
		expect(drawn()).toContain("6")
	})

	it("hands the app its shortcuts, and leaves the key's default when the app does not take one", async () => {
		const taken = await mount(BOOK, { take: ["find"] })

		expect(key(taken.scroller, { key: "f", code: "KeyF", ctrlKey: true }).defaultPrevented).toBe(true)
		expect(taken.shortcuts).toContain("find")

		const left = await mount(BOOK)

		expect(key(left.scroller, { key: "s", code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(false)
		expect(left.shortcuts).toContain("save")
	})

	it("acts on the keys a user bound, and no more on the ones moved away", async () => {
		const { model, scroller, shortcuts } = await mount(BOOK, {
			bindings: { fillDown: "", bold: "mod+alt+b", save: "mod+e" },
			take: ["save"]
		})

		act(() =>
			model.select({
				active: { row: 0, col: 0 },
				anchor: { row: 0, col: 0 },
				focus: { row: 1, col: 0 },
				ranges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 }]
			})
		)
		key(scroller, { key: "d", code: "KeyD", ctrlKey: true })
		await settle()
		expect(await text(model, 1, 0)).toBe("2")

		const bold = key(scroller, { key: "b", code: "KeyB", ctrlKey: true, altKey: true })

		await settle()
		expect(bold.defaultPrevented).toBe(true)
		expect(model.getSnapshot().state.canUndo).toBe(true)
		expect(key(scroller, { key: "e", code: "KeyE", ctrlKey: true }).defaultPrevented).toBe(true)
		expect(shortcuts).toEqual(["bold", "save"])
	})

	it("hands the app its save from an entry being typed, on the default key and on a rebound one", async () => {
		for (const bindings of [undefined, { save: "mod+shift+e" }]) {
			const { scroller, shortcuts } = await mount(BOOK, { take: ["save"], ...(bindings !== undefined && { bindings }) })

			key(scroller, { key: "F2", code: "F2" })

			const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement
			const saved = key(
				editor,
				bindings === undefined
					? { key: "s", code: "KeyS", ctrlKey: true }
					: { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true }
			)

			expect(saved.defaultPrevented).toBe(true)
			expect(shortcuts).toEqual(["save"])

			for (const root of roots.splice(0)) act(() => root.unmount())
			document.body.innerHTML = ""
		}
	})

	it("leaves the save key's default in an entry when the app does not take it", async () => {
		const { scroller } = await mount(BOOK)

		key(scroller, { key: "F2", code: "F2" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		expect(key(editor, { key: "s", code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(false)
	})

	it("goes to the first cell under frozen panes with Ctrl+Home", async () => {
		const pane =
			'<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>'
		const { model, scroller } = await mount({
			sheets: [
				{
					name: "One",
					body: `${pane}${sheetBody([
						[1, 2],
						[3, 4],
						[5, 6]
					])}`
				}
			]
		})

		act(() =>
			model.select({
				active: { row: 9, col: 9 },
				anchor: { row: 9, col: 9 },
				focus: { row: 9, col: 9 },
				ranges: [{ startRow: 9, startCol: 9, endRow: 9, endCol: 9 }]
			})
		)
		key(scroller, { key: "Home", code: "Home", ctrlKey: true })

		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 1 })
	})
})

describe("a right-to-left sheet", () => {
	const RTL = '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>'

	it("shows column A at the right and hit-tests the pointer mirrored", async () => {
		const { handle, scroller } = await mount({ sheets: [{ name: "One", body: `${RTL}${sheetBody([[1, 2, 3]])}` }] })
		const rect = scroller.getBoundingClientRect()

		// Past the row header, which sits at the right edge.
		expect(handle.hit(rect.left + 800 - 34 - 10, rect.top + 30)).toEqual({ kind: "cell", row: 0, col: 0 })
	})

	it("moves left and right the way the arrows point on screen, and Tab to the next column", async () => {
		const { model, scroller } = await mount({ sheets: [{ name: "One", body: `${RTL}${sheetBody([[1, 2, 3, null, 5]])}` }] })

		key(scroller, { key: "ArrowLeft", code: "ArrowLeft" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 1 })

		key(scroller, { key: "ArrowRight", code: "ArrowRight" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })

		key(scroller, { key: "Tab", code: "Tab" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 1 })

		// Ctrl+Left goes on screen to the left: the end of the data in the next columns.
		key(scroller, { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 2 })

		key(scroller, { key: "ArrowRight", code: "ArrowRight", ctrlKey: true })
		await settle()
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })
	})
})

describe("selection on a protected sheet", () => {
	// xf 2 unlocks its cells; the default format locks them.
	const styles = STYLES.replace('<cellXfs count="2">', '<cellXfs count="3">').replace(
		"</cellXfs>",
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs>'
	)
	const body = (protection: string): string =>
		'<sheetData><row r="1"><c r="A1" s="2"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1" s="2"><v>3</v></c></row></sheetData>' +
		protection

	it("passes over locked cells when they may not be selected, and takes no click on one", async () => {
		const { model, scroller, handle } = await mount({
			sheets: [{ name: "One", body: body('<sheetProtection sheet="1" selectLockedCells="1"/>') }],
			styles
		})

		key(scroller, { key: "ArrowRight", code: "ArrowRight" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 2 })

		act(() => handle.goTo({ row: 0, col: 1 }))
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 2 })

		key(scroller, { key: "ArrowLeft", code: "ArrowLeft" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })
	})

	it("selects nothing anew when no cell may be selected", async () => {
		const { model, scroller } = await mount({
			sheets: [{ name: "One", body: body('<sheetProtection sheet="1" selectLockedCells="1" selectUnlockedCells="1"/>') }],
			styles
		})
		const before = model.getSnapshot().selection

		key(scroller, { key: "ArrowRight", code: "ArrowRight" })
		expect(model.getSnapshot().selection).toBe(before)
	})

	it("selects as ever when the protection allows it", async () => {
		const { model, scroller } = await mount({
			sheets: [{ name: "One", body: body('<sheetProtection sheet="1"/>') }],
			styles
		})

		key(scroller, { key: "ArrowRight", code: "ArrowRight" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 1 })
	})
})

// Excel: after Tab through a row of entries, Enter goes to the start of the next row (support.microsoft.com, "Enter
// data manually in worksheet cells").
describe("Enter after a run of Tabs", () => {
	const editor = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

	it("goes to the next row in the column the entries began in", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "a", code: "KeyA" })
		key(editor(), { key: "Tab", code: "Tab" })
		key(scroller, { key: "b", code: "KeyB" })
		key(editor(), { key: "Tab", code: "Tab" })
		key(scroller, { key: "c", code: "KeyC" })
		key(editor(), { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 0 })

		// The run ended: Enter goes on down the column.
		key(scroller, { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 0 })
		await settle()
	})

	it("goes back to where Tab moves without entries began", async () => {
		const { model, scroller, handle } = await mount()

		act(() => handle.goTo({ row: 0, col: 3 }))
		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "Tab", code: "Tab", shiftKey: true })
		key(scroller, { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 3 })
	})

	it("goes down the current column once another move ends the run", async () => {
		const { model, scroller } = await mount()

		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "ArrowRight", code: "ArrowRight" })
		key(scroller, { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 2 })

		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "ArrowUp", code: "ArrowUp" })
		key(scroller, { key: "ArrowDown", code: "ArrowDown" })
		key(scroller, { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 3 })
	})

	it("lands on a merge's first cell when the column it began in is merged on the next row", async () => {
		const { model, scroller, handle } = await mount({
			sheets: [{ name: "One", body: `${sheetBody([[1, 2, 3]])}<mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells>` }]
		})

		act(() => handle.goTo({ row: 0, col: 1 }))
		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "Tab", code: "Tab" })
		key(scroller, { key: "Enter", code: "Enter" })
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 0 })
	})
})

describe("entries in a text file", () => {
	it("shows an entry in a row the file did not have when the active cell comes back to it", async () => {
		const { model, scroller, handle } = await mount("a,b\r\n1,2\r\n")

		act(() => handle.goTo({ row: 2, col: 0 }))
		key(scroller, { key: "x", code: "KeyX" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		key(editor, { key: "Enter", code: "Enter" })
		await settle()
		act(() => handle.renderer.paint())
		await settle()

		act(() => handle.goTo({ row: 4, col: 0 }))
		await settle()
		act(() => handle.goTo({ row: 2, col: 0 }))
		await settle()
		act(() => handle.renderer.paint())
		await settle()

		expect(model.getSnapshot().active).toMatchObject({ text: "x", input: "x", known: true })
	})

	it("keeps the active cell's contents while the view scrolls far from it", async () => {
		const { model, handle } = await mount("a,b\r\n1,2\r\n")

		act(() => handle.goTo({ row: 1, col: 0 }))
		await settle()
		expect(model.getSnapshot().active).toMatchObject({ input: "1", known: true })

		// Scrolled a few hundred rows at a time, the view needs other tiles: the cache drops what it does not need.
		for (let step = 0; step < 60; step++) {
			act(() => {
				handle.renderer.scrollBy(0, 20_000)
				handle.renderer.paint()
			})
			await settle()
		}

		expect(model.tiles.has(0)).toBe(true)
		expect(model.getSnapshot().active).toMatchObject({ input: "1", known: true })
	})
})

describe("the active cell after rows and columns move", () => {
	it("reads what the tiles show after rows and columns are inserted and deleted", async () => {
		const { model, handle } = await mount({
			sheets: [
				{
					name: "One",
					body: sheetBody([
						["Item", "Cost"],
						["Rent", 1200],
						["Food", 300]
					])
				}
			]
		})
		const at = async (row: number, col: number): Promise<{ text: string; input: string; known: boolean }> => {
			act(() => handle.goTo({ row, col }))
			await settle()
			act(() => handle.renderer.paint())
			await settle()

			const found = model.entry(0, row, col)
			const painted = found === null ? "" : (found.tile.strings[found.tile.texts[found.entry] ?? -1] ?? "")
			const { text, input, known } = model.getSnapshot().active

			expect(text).toBe(painted)

			return { text, input, known }
		}
		const run = async (command: Parameters<SheetGridModel["command"]>[0]): Promise<void> => {
			await act(async () => {
				await model.command(command)
			})
			await settle()
		}

		await run({ type: "axis.insert", sheet: 0, axis: "rows", at: 1, count: 1 })
		await run({ type: "axis.insert", sheet: 0, axis: "cols", at: 0, count: 1 })
		expect(await at(2, 1)).toMatchObject({ text: "Rent", known: true })
		await run({ type: "axis.delete", sheet: 0, axis: "rows", at: 1, count: 1 })
		expect(await at(1, 1)).toMatchObject({ text: "Rent", known: true })
		await run({ type: "axis.delete", sheet: 0, axis: "cols", at: 0, count: 1 })
		expect(await at(1, 0)).toMatchObject({ text: "Rent", input: "Rent", known: true })
		expect(await at(1, 1)).toMatchObject({ text: "1200", known: true })
	})
})
