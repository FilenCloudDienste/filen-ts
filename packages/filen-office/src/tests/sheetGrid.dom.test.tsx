// @vitest-environment happy-dom
import { act, createRef, useEffect, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import {
	DEFAULT_THEME,
	MAX_SCROLL_PX,
	SheetGrid,
	SheetGridModel,
	readTheme,
	type SheetGridHandle,
	type SheetGridKeptSizes,
	type SheetGridSizes
} from "../react/sheet/index"
import { RecordingCanvas } from "./sheetGridCanvas"
import { BASIC, IMMEDIATE, buildFixture } from "./sheetSessionFixtures"

// The grid component on the in-thread host: ARIA grid semantics and the active cell's live region, keyboard and
// pointer selection, the in-cell editor (typing, input methods, Enter and Escape), resizing and autofit from the
// headers, and scaled scrolling to the sheet's last row.

const WIDTH = 800
const HEIGHT = 400
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
		return this.classList.contains("fo-sheet-scroller") ? WIDTH : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? HEIGHT : 0
	})
	vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => undefined)
})

const roots: Root[] = []

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
})

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

interface Mounted {
	readonly model: SheetGridModel
	readonly handle: SheetGridHandle
	readonly root: Root
	readonly scroller: HTMLElement
	readonly cells: RecordingCanvas
	paint(): void
}

async function mount(bytes = buildFixture(BASIC)): Promise<Mounted> {
	const host = inThreadSheetHost()
	const opened = await host.open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ session: opened.session, info: opened.info })
	const container = document.createElement("div")
	const ref = createRef<SheetGridHandle>()
	const root = createRoot(container)

	roots.push(root)

	document.body.appendChild(container)
	await act(async () => {
		root.render(
			<SheetGrid
				ref={ref}
				grid={model}
				label="Sheet"
				editorLabel="Cell entry"
				resizeLabel={(axis, px) => `${axis} ${String(px)}`}
			/>
		)
	})
	await settle()

	const handle = ref.current as SheetGridHandle
	const scroller = container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement
	const cells = canvases.get(container.querySelector("canvas") as HTMLCanvasElement) as RecordingCanvas
	const paint = (): void => {
		act(() => handle.renderer.paint())
	}

	paint()
	await settle()
	paint()

	return { model, handle, root, scroller, cells, paint }
}

function key(target: Element, init: KeyboardEventInit & { keyCode?: number }): void {
	act(() => {
		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

		if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode })

		target.dispatchEvent(event)
	})
}

function pointer(target: Element, type: string, init: PointerEventInit): void {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, ...init })
		)
	})
}

function cellCenter(handle: SheetGridHandle, row: number, col: number): { clientX: number; clientY: number } {
	const view = handle.renderer.currentView()

	if (view === null) throw new Error("no view")

	const box = handle.renderer.cellBox(view, { row, col })

	if (box === null) throw new Error("off screen")

	return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
}

function live(scroller: HTMLElement): string {
	return scroller.parentElement?.querySelector(".fo-sheet-live")?.textContent ?? ""
}

describe("SheetGrid", () => {
	it("is an ARIA grid whose active descendant and live region say the active cell", async () => {
		const { scroller, cells } = await mount()

		expect(scroller.getAttribute("role")).toBe("grid")
		expect(scroller.getAttribute("aria-label")).toBe("Sheet")
		expect(scroller.getAttribute("aria-rowcount")).toBe(String(SHEET_MAX_ROWS))
		expect(scroller.getAttribute("aria-multiselectable")).toBe("true")

		const active = document.getElementById(scroller.getAttribute("aria-activedescendant") ?? "")

		expect(active?.getAttribute("role")).toBe("gridcell")
		expect(active?.parentElement?.getAttribute("role")).toBe("row")
		expect(active?.textContent).toBe("2")
		expect(live(scroller)).toBe("A1 2")
		expect(cells.texts()).toEqual(expect.arrayContaining(["2", "hello", "6"]))

		key(scroller, { key: "ArrowRight" })

		expect(active?.getAttribute("aria-colindex")).toBe("2")
		expect(live(scroller)).toBe("B1 hello")
	})

	it("opens the editor on a typed character, shows the entry at once and commits it with Enter", async () => {
		const { scroller, model, cells, paint } = await mount()

		key(scroller, { key: "7" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor")

		expect(editor?.value).toBe("7")
		expect(document.activeElement).toBe(editor)
		expect(editor?.getAttribute("aria-label")).toBe("Cell entry")

		key(editor as HTMLTextAreaElement, { key: "Enter" })
		cells.reset()
		paint()

		// Drawn before the session answers.
		expect(cells.texts()).toContain("7")
		expect(document.querySelector("textarea")).toBeNull()
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 0 })
		expect(document.activeElement).toBe(scroller)

		// Recorded from before the answer: the frame it brings draws the cells again, and a frame after it with nothing
		// new leaves them as drawn.
		cells.reset()
		await settle()
		paint()

		expect(cells.texts()).toEqual(expect.arrayContaining(["7", "21"]))
	})

	it("draws only the chrome for a selection move or an entry's keystroke, and the cells again once what they show changed", async () => {
		const { scroller, model, cells, paint } = await mount()
		const canvasList = scroller.parentElement?.querySelectorAll("canvas") ?? []
		const chrome = canvases.get(canvasList[canvasList.length - 1] as HTMLCanvasElement) as RecordingCanvas

		expect(chrome).not.toBe(cells)

		cells.reset()
		chrome.reset()

		// Moves within the extent, and an entry typed into, change nothing the cells show.
		for (const arrow of ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "ArrowUp"]) {
			key(scroller, { key: arrow })
			paint()
		}

		expect(cells.calls).toEqual([])

		// Past the furthest row reached the extent grows, and the cells are laid out on the grown axes.
		for (const arrow of ["ArrowDown", "ArrowDown", "ArrowDown"]) key(scroller, { key: arrow })

		paint()

		expect(cells.calls.length).toBeGreaterThan(0)

		for (const arrow of ["ArrowUp", "ArrowUp", "ArrowUp"]) key(scroller, { key: arrow })

		paint()
		cells.reset()
		chrome.reset()
		key(scroller, { key: "7" })
		paint()

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		act(() => model.setEditText("75"))
		paint()

		expect(cells.calls).toEqual([])
		expect(chrome.calls.length).toBeGreaterThan(0)

		// The entry, shown before the session answers.
		key(editor, { key: "Enter" })
		paint()

		expect(cells.texts()).toContain("75")

		// Anything that may change what is drawn (here an extension's own repaint) draws them again.
		cells.reset()
		paint()

		expect(cells.calls).toEqual([])

		act(() => model.repaint())
		paint()

		expect(cells.texts().length).toBeGreaterThan(0)

		// A resized canvas (here for a new pixel ratio) has lost what it showed.
		const ratio = globalThis.devicePixelRatio

		cells.reset()
		Reflect.set(globalThis, "devicePixelRatio", 2)

		try {
			paint()
		} finally {
			Reflect.set(globalThis, "devicePixelRatio", ratio)
		}

		expect(cells.texts().length).toBeGreaterThan(0)
	})

	it("leaves the entry open when the window loses focus, and commits it when focus moves within the page", async () => {
		const { scroller, model } = await mount()

		key(scroller, { key: "h" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false)
		const blur = (): void => {
			act(() => {
				editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }))
			})
		}

		act(() => model.setEditText("half typ"))
		// The window goes to the background: the editor blurs with nothing focused after it.
		blur()
		await settle()

		expect(model.getSnapshot().editing?.text).toBe("half typ")

		hasFocus.mockReturnValue(true)
		blur()
		await settle()

		expect(model.getSnapshot().editing).toBeNull()
		expect(model.pendingText(model.getSnapshot().sheet, 0, 0) ?? model.getSnapshot().active.input).toBe("half typ")
	})

	it("opens an empty editor synchronously for an input method's key, so the composition lands in it", async () => {
		const { scroller } = await mount()

		key(scroller, { key: "Process", keyCode: 229 })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor")

		expect(editor?.value).toBe("")
		expect(document.activeElement).toBe(editor)

		// Keys of the composition are the input method's: Enter confirms it and commits nothing.
		key(editor as HTMLTextAreaElement, { key: "Enter", isComposing: true })

		expect(document.querySelector("textarea.fo-sheet-editor")).not.toBeNull()

		key(editor as HTMLTextAreaElement, { key: "Escape" })

		expect(document.querySelector("textarea")).toBeNull()
		expect(document.activeElement).toBe(scroller)
	})

	it("selects with the pointer: a click, a drag, Shift to extend and Ctrl to add a range", async () => {
		const { scroller, model, handle } = await mount()

		pointer(scroller, "pointerdown", cellCenter(handle, 1, 1))
		pointer(scroller, "pointermove", cellCenter(handle, 2, 2))
		pointer(scroller, "pointerup", cellCenter(handle, 2, 2))

		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 1 })
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }])

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 4, 0), ctrlKey: true })
		pointer(scroller, "pointerup", cellCenter(handle, 4, 0))

		expect(model.getSnapshot().selection.ranges).toHaveLength(2)

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 6, 1), shiftKey: true })
		pointer(scroller, "pointerup", cellCenter(handle, 6, 1))

		expect(model.getSnapshot().selection.ranges[1]).toEqual({ startRow: 4, startCol: 0, endRow: 6, endCol: 1 })

		// A touch selects on a tap, never on a pan.
		pointer(scroller, "pointerdown", { ...cellCenter(handle, 3, 3), pointerType: "touch", pointerId: 2 })
		pointer(scroller, "pointerup", {
			...cellCenter(handle, 3, 3),
			clientY: cellCenter(handle, 3, 3).clientY + 40,
			pointerType: "touch",
			pointerId: 2
		})

		expect(model.getSnapshot().selection.active).toEqual({ row: 4, col: 0 })

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 3, 3), pointerType: "touch", pointerId: 3 })
		pointer(scroller, "pointerup", { ...cellCenter(handle, 3, 3), pointerType: "touch", pointerId: 3 })

		expect(model.getSnapshot().selection.active).toEqual({ row: 3, col: 3 })
	})

	it("selects a header's whole column or row on a right-click, unless one selected already holds it", async () => {
		const { scroller, model, handle } = await mount()
		const view = handle.renderer.currentView()

		if (view === null) throw new Error("no view")

		const colHeader = { clientX: cellCenter(handle, 0, 2).clientX, clientY: view.rows.header / 2, button: 2 }
		const rowHeader = { clientX: view.cols.header / 2, clientY: cellCenter(handle, 3, 0).clientY, button: 2 }
		const column = { startRow: 0, startCol: 2, endRow: SHEET_MAX_ROWS - 1, endCol: 2 }

		// A cell of the column selected is not enough.
		pointer(scroller, "pointerdown", cellCenter(handle, 1, 2))
		pointer(scroller, "pointerup", cellCenter(handle, 1, 2))
		pointer(scroller, "pointerdown", colHeader)
		pointer(scroller, "pointerup", colHeader)

		expect(model.getSnapshot().selection.ranges).toEqual([column])

		pointer(scroller, "pointerdown", rowHeader)
		pointer(scroller, "pointerup", rowHeader)

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 3, startCol: 0, endRow: 3, endCol: SHEET_MAX_COLS - 1 }])

		// Inside a selection that holds the whole column, on a cell of it or its header, the selection stays.
		const leftColHeader = { clientX: colHeader.clientX, clientY: colHeader.clientY }

		pointer(scroller, "pointerdown", leftColHeader)
		pointer(scroller, "pointerup", leftColHeader)
		pointer(scroller, "pointerdown", { ...cellCenter(handle, 5, 2), button: 2 })
		pointer(scroller, "pointerup", cellCenter(handle, 5, 2))

		expect(model.getSnapshot().selection.ranges).toEqual([column])

		pointer(scroller, "pointerdown", colHeader)
		pointer(scroller, "pointerup", colHeader)

		expect(model.getSnapshot().selection.ranges).toEqual([column])
	})

	it("resizes a column by dragging its header edge and fits it to its content on a double-click", async () => {
		const { scroller, model, handle } = await mount()
		const view = handle.renderer.currentView()

		if (view === null) throw new Error("no view")

		const edge = view.cols.header + view.cols.axis.size(0) - 1

		pointer(scroller, "pointerdown", { clientX: edge, clientY: 10 })
		pointer(scroller, "pointermove", { clientX: edge + 36, clientY: 10 })

		expect(model.getDraft()?.sizes.get(0)).toBe(100)
		expect(scroller.parentElement?.querySelector(".fo-sheet-tip")?.textContent).toBe("cols 100")

		pointer(scroller, "pointerup", { clientX: edge + 36, clientY: 10 })
		await settle()

		expect(model.getDraft()).toBeNull()
		expect(model.axes(model.getSnapshot().sheet)?.cols.size(0)).toBe(100)

		const header = handle.renderer.currentView()?.cols.header ?? 0

		act(() => {
			scroller.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: header + 100 - 1, clientY: 10 }))
		})
		await settle()

		// Column A's widest text is "45002" (shown as a date's serial in this fixture's General format) or "2":
		// fitted to it, padding included, and never wider than before.
		const fitted = model.axes(model.getSnapshot().sheet)?.cols.size(0) ?? 0

		expect(fitted).toBeLessThan(100)
		expect(fitted).toBeGreaterThan(8)
	})

	it("scrolls to the sheet's last row through a scroll range the browsers can hold", async () => {
		const { model, handle, scroller, paint } = await mount()

		act(() => handle.goTo({ row: SHEET_MAX_ROWS - 1, col: 0 }))
		paint()

		const view = handle.renderer.currentView()
		const extent = scroller.querySelector<HTMLElement>(".fo-sheet-extent")

		expect(model.getSnapshot().selection.active.row).toBe(SHEET_MAX_ROWS - 1)
		expect(view?.rows.last).toBe(SHEET_MAX_ROWS - 1)
		expect(Number.parseFloat(extent?.style.height ?? "0")).toBeLessThanOrEqual(MAX_SCROLL_PX + 100)
		expect(scroller.scrollTop).toBeGreaterThan(0)
		expect(scroller.scrollTop).toBeLessThanOrEqual(MAX_SCROLL_PX)

		const hit = handle.hit(cellCenter(handle, SHEET_MAX_ROWS - 1, 0).clientX, cellCenter(handle, SHEET_MAX_ROWS - 1, 0).clientY)

		expect(hit).toEqual({ kind: "cell", row: SHEET_MAX_ROWS - 1, col: 0 })
	})

	it("reads its colours from the --fo-sheet-* variables", () => {
		const element = document.createElement("div")

		element.style.setProperty("--fo-sheet-bg", "#123456")
		element.style.setProperty("--fo-sheet-font", "Inter, sans-serif")
		document.body.appendChild(element)

		expect(readTheme(element)).toMatchObject({ background: "#123456", font: "Inter, sans-serif", gridLine: DEFAULT_THEME.gridLine })
	})

	it("draws the theme an app sets in its own effect when it changes the theme key", async () => {
		const host = inThreadSheetHost()
		const opened = await host.open(buildFixture(BASIC), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const model = new SheetGridModel({ session: opened.session, info: opened.info })
		const container = document.createElement("div")
		const ref = createRef<SheetGridHandle>()
		const root = createRoot(container)
		const BACKGROUNDS = { light: "#fafafa", dark: "#202020" } as const

		// As an app's theme provider does: its effect, which runs after the grid's, moves the variables (this DOM
		// inherits no custom property, so they go on the grid's own root).
		function App({ theme }: { theme: keyof typeof BACKGROUNDS }) {
			useEffect(() => {
				container.querySelector<HTMLElement>(".fo-sheet")?.style.setProperty("--fo-sheet-bg", BACKGROUNDS[theme])
			}, [theme])

			return (
				<SheetGrid
					ref={ref}
					grid={model}
					label="Sheet"
					editorLabel="Cell entry"
					themeKey={theme}
					resizeLabel={(axis, px) => `${axis} ${String(px)}`}
				/>
			)
		}

		roots.push(root)
		document.body.appendChild(container)
		await act(async () => root.render(<App theme="light" />))
		await settle()

		const handle = ref.current as SheetGridHandle
		const cells = canvases.get(container.querySelector("canvas") as HTMLCanvasElement) as RecordingCanvas
		// The fill of the cells' last clear: a frame with nothing new to draw leaves the canvas as it was.
		const background = (): unknown => {
			act(() => handle.renderer.paint())

			const fill = cells.calls.findLast(call => call.op === "fillRect" && call.args[0] === 0 && call.args[1] === 0)?.fill

			cells.reset()

			return fill
		}

		expect(background()).toBe(BACKGROUNDS.light)

		await act(async () => root.render(<App theme="dark" />))

		expect(background()).toBe(BACKGROUNDS.dark)

		await act(async () => root.render(<App theme="light" />))

		expect(background()).toBe(BACKGROUNDS.light)
	})

	it("keeps one handle across renders with new callbacks, so an overlay mounting in a later render can reach it", async () => {
		const host = inThreadSheetHost()
		const opened = await host.open(buildFixture(BASIC), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const model = new SheetGridModel({ session: opened.session, info: opened.info })
		const container = document.createElement("div")
		const ref = createRef<SheetGridHandle>()
		const root = createRoot(container)
		const seen: (SheetGridHandle | null)[] = []

		// What the touch menu and a note's card do: read the handle in a layout effect on mount, to place themselves.
		function Overlay() {
			useLayoutEffect(() => {
				seen.push(ref.current)
			}, [])

			return null
		}

		// An app passing a new shortcut callback on every render, as a component without memoization does.
		function App({ overlay }: { overlay: boolean }) {
			return (
				<SheetGrid
					ref={ref}
					grid={model}
					label="Sheet"
					editorLabel="Cell entry"
					resizeLabel={(axis, px) => `${axis} ${String(px)}`}
					onShortcut={() => overlay}
				>
					{overlay ? <Overlay /> : null}
				</SheetGrid>
			)
		}

		roots.push(root)
		document.body.appendChild(container)
		await act(async () => root.render(<App overlay={false} />))
		await settle()

		const first = ref.current

		await act(async () => root.render(<App overlay />))

		expect(first).not.toBeNull()
		expect(ref.current).toBe(first)
		expect(seen).toEqual([first])
	})

	it("keeps each sheet's scroll position and selection when switching back to it", async () => {
		const { model, handle, paint } = await mount()
		const first = model.getSnapshot().sheet
		const second = model.getSnapshot().sheets[1]?.id as number

		act(() => handle.goTo({ row: 500, col: 2 }))
		paint()

		const scrolled = handle.renderer.currentView()?.rows.scroll ?? 0

		expect(scrolled).toBeGreaterThan(0)

		act(() => model.setSheet(second))
		await settle()
		paint()

		expect(handle.renderer.currentView()?.rows.scroll).toBe(0)

		act(() => model.setSheet(first))
		paint()

		expect(handle.renderer.currentView()?.rows.scroll).toBe(scrolled)
		expect(model.getSnapshot().selection.active).toEqual({ row: 500, col: 2 })
	})

	it("resizes and autofits into the app's size layer when the file is view-only", async () => {
		const { scroller, model, handle, root } = await mount()
		const command = vi.spyOn(model.session, "command")
		let kept: SheetGridKeptSizes = { cols: new Map(), rows: new Map() }
		const updates: unknown[] = []
		const layer = (): SheetGridSizes => ({
			sizes: () => kept,
			update: (_sheet, axis, entries) => {
				updates.push([axis, entries])

				const cols = new Map(kept.cols)

				for (const [index, px] of entries) if (px !== null) cols.set(index, px)

				kept = { ...kept, cols }
				rerender(layer())
			},
			follow: () => undefined
		})
		const rerender = (sizes: SheetGridSizes): void => {
			root.render(
				<SheetGrid
					grid={model}
					label="Sheet"
					editorLabel="Cell entry"
					sizes={sizes}
				/>
			)
		}

		act(() => model.setReadOnly(true))
		act(() => rerender(layer()))

		const view = handle.renderer.currentView()

		if (view === null) throw new Error("no view")

		const edge = view.cols.header + view.cols.axis.size(0) - 1

		pointer(scroller, "pointerdown", { clientX: edge, clientY: 10 })
		pointer(scroller, "pointermove", { clientX: edge + 36, clientY: 10 })
		pointer(scroller, "pointerup", { clientX: edge + 36, clientY: 10 })
		await settle()

		expect(updates).toEqual([["cols", [[0, 100]]]])
		expect(model.getDraft()).toBeNull()
		expect(model.axes(model.getSnapshot().sheet)?.cols.size(0)).toBe(100)

		act(() => {
			scroller.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: view.cols.header + 100 - 1, clientY: 10 }))
		})
		await settle()

		expect(updates).toHaveLength(2)
		expect(model.axes(model.getSnapshot().sheet)?.cols.size(0)).toBeLessThan(100)
		expect(command).not.toHaveBeenCalled()
	})

	it("starts no entry in a view-only grid and says so", async () => {
		const { scroller, model } = await mount()

		act(() => model.setReadOnly(true))
		key(scroller, { key: "x" })

		expect(document.querySelector("textarea")).toBeNull()
		expect(scroller.getAttribute("aria-readonly")).toBe("true")
	})
})

// A cell whose text is past what a tile holds (32,767 characters): its whole input comes from the cell query.
const LONG = `${"x".repeat(40_000)}END`

function clippedFixture(): Uint8Array {
	return buildFixture({
		sheets: [
			{
				name: "One",
				body: `<dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${LONG}</t></is></c><c r="B1"><v>5</v></c></row></sheetData>`
			}
		]
	})
}

async function inputOf(model: SheetGridModel, row: number, col: number): Promise<string> {
	return (await model.session.query("cell", { sheet: model.getSnapshot().sheet, row, col })).input
}

describe("SheetGrid: an entry on a cell whose input is not known yet", () => {
	it("edits a clipped cell's whole input from F2 even before the query answers, and an unchanged Enter keeps it", async () => {
		const { scroller, model } = await mount(clippedFixture())

		key(scroller, { key: "ArrowRight" })
		key(scroller, { key: "ArrowLeft" })
		key(scroller, { key: "F2" })
		await settle()

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		expect(editor.value).toBe(LONG)
		key(editor, { key: "Enter" })
		await settle()

		expect(await inputOf(model, 0, 0)).toBe(LONG)
		expect(model.getSnapshot().state.dirty).toBe(false)
	})

	it("commits F2 then Enter pressed before the query answers as unchanged", async () => {
		const { scroller, model } = await mount(clippedFixture())

		key(scroller, { key: "ArrowRight" })
		key(scroller, { key: "ArrowLeft" })
		key(scroller, { key: "F2" })
		key(document.querySelector("textarea.fo-sheet-editor") as HTMLTextAreaElement, { key: "Enter" })
		await settle()

		expect(await inputOf(model, 0, 0)).toBe(LONG)
		expect(model.getSnapshot().state.dirty).toBe(false)
	})

	it("clears a clipped cell on Backspace then Enter, before the query answers", async () => {
		const { scroller, model } = await mount(clippedFixture())

		key(scroller, { key: "ArrowRight" })
		key(scroller, { key: "ArrowLeft" })
		key(scroller, { key: "Backspace" })
		key(document.querySelector("textarea.fo-sheet-editor") as HTMLTextAreaElement, { key: "Enter" })
		await settle()

		expect(await inputOf(model, 0, 0)).toBe("")
	})

	it("clears a clipped cell on Backspace then Enter right after its tile changed", async () => {
		const { scroller, model } = await mount(clippedFixture())

		// An edit of B1, in the same tile, patches it: A1's whole input is asked for again.
		key(scroller, { key: "ArrowRight" })
		key(scroller, { key: "7" })
		key(document.querySelector("textarea.fo-sheet-editor") as HTMLTextAreaElement, { key: "Enter" })
		await settle()
		key(scroller, { key: "ArrowUp" })
		key(scroller, { key: "ArrowLeft" })
		key(scroller, { key: "Backspace" })
		key(document.querySelector("textarea.fo-sheet-editor") as HTMLTextAreaElement, { key: "Enter" })
		await settle()

		expect(await inputOf(model, 0, 0)).toBe("")
	})
})

describe("SheetGrid: a formula pointing at another sheet", () => {
	it("moves through the sheets with Ctrl+Alt+Page Down keeping the entry, and Enter commits it on its own sheet", async () => {
		const { scroller, model } = await mount()
		const first = model.getSnapshot().sheet
		const second = model.getSnapshot().sheets[1]?.id

		key(scroller, { key: "=" })

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement

		act(() => model.setEditText("=1+"))
		key(editor, { key: "PageDown", code: "PageDown", ctrlKey: true, altKey: true })
		await settle()

		expect(model.getSnapshot().sheet).toBe(second)
		expect(model.getSnapshot().editing).toMatchObject({ sheet: first, text: "=1+" })
		expect(document.activeElement).toBe(editor)
		// Its own cell is not on the sheet shown: the editor keeps focus off screen.
		expect((editor.parentElement as HTMLElement).style.transform).toBe("translate(-9999px, 0)")

		act(() => model.setEditText("=1+Two!A1"))
		key(editor, { key: "Enter" })
		await settle()

		expect(model.getSnapshot().sheet).toBe(first)
		expect(model.getSnapshot().editing).toBeNull()
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 0 })
		expect(await inputOf(model, 0, 0)).toBe("=1+Two!A1")
	})
})
