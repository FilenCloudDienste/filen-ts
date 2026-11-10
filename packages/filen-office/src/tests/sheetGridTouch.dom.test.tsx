// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SHEET_MAX_ROWS } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { DEFAULT_THEME, SheetGrid, SheetGridModel, type SheetGridHandle, type SheetGridProps } from "../react/sheet/index"
import { DOUBLE_TAP_MS, LONG_PRESS_MS, dragStartHandle, isDoubleTap, isSoleCell, isTap } from "../react/sheet/touch/gestures"
import { cellSelection } from "../react/sheet/selection"
import { toDom } from "../react/sheet/scroll"
import { bodyTotal } from "../react/sheet/view"
import { RecordingCanvas } from "./sheetGridCanvas"
import { BASIC, IMMEDIATE, buildFixture } from "./sheetSessionFixtures"
import { KEPT, barChart, withChartsheet } from "./sheetChartFixtures"

// The grid under a finger and a screen reader: a tap selects, a double tap opens the entry with the soft keyboard
// (the hidden input focused first), a long press or a tap on the cell that is the selection asks for the touch menu,
// the start handle drags a touch selection wider, keys and the mouse leave touch; a wheel on a sheet past the
// browsers' scroll range moves the sheet by its own pixels; the live region says the selection.

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
	vi.useRealTimers()
})

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

async function wait(ms: number): Promise<void> {
	await act(() => new Promise(resolve => setTimeout(resolve, ms)))
}

interface Mounted {
	readonly model: SheetGridModel
	readonly handle: SheetGridHandle
	readonly scroller: HTMLElement
	readonly root: HTMLElement
	readonly menu: boolean[]
	// The chrome canvas: headers and the selection.
	readonly chrome: RecordingCanvas
	paint(): void
}

async function mount(props: Partial<SheetGridProps> = {}, bytes = buildFixture(BASIC)): Promise<Mounted> {
	const host = inThreadSheetHost()
	const opened = await host.open(bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ session: opened.session, info: opened.info })
	const container = document.createElement("div")
	const ref = createRef<SheetGridHandle>()
	const root = createRoot(container)
	const menu: boolean[] = []

	roots.push(root)
	document.body.appendChild(container)
	await act(async () => {
		root.render(
			<SheetGrid
				ref={ref}
				grid={model}
				label="Sheet"
				editorLabel="Cell entry"
				describeSelection={range => `${range} selected`}
				onTouchMenu={shown => menu.push(shown)}
				{...props}
			/>
		)
	})
	await settle()

	const handle = ref.current as SheetGridHandle
	const scroller = container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement
	const paint = (): void => {
		act(() => handle.renderer.paint())
	}

	paint()
	await settle()
	paint()

	const chrome = canvases.get(container.querySelectorAll("canvas")[1] as HTMLCanvasElement) as RecordingCanvas

	return { model, handle, scroller, root: container.querySelector<HTMLElement>(".fo-sheet") as HTMLElement, menu, chrome, paint }
}

function pointer(target: Element, type: string, init: PointerEventInit): void {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, ...init })
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

function tap(scroller: Element, at: { clientX: number; clientY: number }, pointerId = 1): void {
	pointer(scroller, "pointerdown", { ...at, pointerId })
	pointer(scroller, "pointerup", { ...at, pointerId })
}

function live(root: HTMLElement): string {
	return root.querySelector(".fo-sheet-live")?.textContent ?? ""
}

function startHandle(root: HTMLElement): HTMLElement {
	return root.querySelector<HTMLElement>(".fo-sheet-touch-handle") as HTMLElement
}

describe("touch gestures", () => {
	it("tells a tap from a pan and a slow press, and a double tap from two taps apart or on two cells", () => {
		const press = { pointerId: 1, x: 100, y: 100, time: 0 }

		expect(isTap(press, 104, 103, 120)).toBe(true)
		expect(isTap(press, 100, 140, 120)).toBe(false)
		expect(isTap(press, 100, 100, 900)).toBe(false)

		const first = { x: 100, y: 100, time: 0, cell: { row: 2, col: 1 } }

		expect(isDoubleTap(first, { x: 108, y: 96, time: DOUBLE_TAP_MS - 10, cell: { row: 2, col: 1 } })).toBe(true)
		expect(isDoubleTap(first, { x: 100, y: 100, time: DOUBLE_TAP_MS + 50, cell: { row: 2, col: 1 } })).toBe(false)
		expect(isDoubleTap(first, { x: 104, y: 100, time: 100, cell: { row: 2, col: 2 } })).toBe(false)
		expect(isDoubleTap(null, first)).toBe(false)
	})

	it("counts a merge as one cell, and drags a start handle from the range's end corner", () => {
		const merges = [{ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }]

		expect(isSoleCell(cellSelection({ row: 1, col: 1 }, merges), { row: 1, col: 1 }, merges)).toBe(true)
		expect(isSoleCell(cellSelection({ row: 4, col: 4 }, []), { row: 4, col: 5 }, [])).toBe(false)

		const selection = cellSelection({ row: 3, col: 3 }, [])
		const range = { startRow: 3, startCol: 3, endRow: 3, endCol: 3 }
		const up = dragStartHandle(selection, range, { row: 1, col: 1 }, [])

		expect(up.ranges).toEqual([{ startRow: 1, startCol: 1, endRow: 3, endCol: 3 }])
		expect(up.active).toEqual({ row: 3, col: 3 })

		// Dragged past the end corner the range flips; the active cell stays inside it.
		const wide = { startRow: 1, startCol: 1, endRow: 3, endCol: 3 }
		const past = dragStartHandle({ ...up, active: { row: 1, col: 1 } }, wide, { row: 5, col: 5 }, [])

		expect(past.ranges).toEqual([{ startRow: 3, startCol: 3, endRow: 5, endCol: 5 }])
		expect(past.active).toEqual({ row: 5, col: 5 })
	})
})

describe("SheetGrid under a finger", () => {
	it("selects on a tap, opens the entry on a double tap with the hidden input focused first, and ignores the browser's dblclick", async () => {
		const { scroller, model, handle, root } = await mount()
		const sink = root.querySelector<HTMLInputElement>(".fo-sheet-touch-sink") as HTMLInputElement
		const sinkFocus = vi.spyOn(sink, "focus")

		tap(scroller, cellCenter(handle, 2, 1))

		expect(model.getSnapshot().selection.active).toEqual({ row: 2, col: 1 })
		expect(model.getSnapshot().editing).toBeNull()

		tap(scroller, cellCenter(handle, 2, 1), 2)

		const editor = document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor")

		expect(sinkFocus).toHaveBeenCalledOnce()
		expect(model.getSnapshot().editing).toMatchObject({ row: 2, col: 1, mode: "edit" })
		// Synchronously, within the tap: the keyboard stays up as focus moves to the entry's field.
		expect(document.activeElement).toBe(editor)

		act(() => model.cancelEditing())
		act(() => {
			scroller.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, ...cellCenter(handle, 2, 1) }))
		})

		expect(model.getSnapshot().editing).toBeNull()
	})

	it("lays the entry out at 16 px or more where a finger may edit, drawn scaled back to the cell's size", async () => {
		const media = vi.spyOn(globalThis, "matchMedia").mockImplementation(
			query =>
				({
					matches: query === "(any-pointer: coarse)",
					media: query,
					addEventListener: () => undefined,
					removeEventListener: () => undefined
				}) as unknown as MediaQueryList
		)

		const { scroller, model, handle, root } = await mount()

		tap(scroller, cellCenter(handle, 2, 1))
		tap(scroller, cellCenter(handle, 2, 1), 2)
		act(() => handle.renderer.paint())

		const box = root.querySelector<HTMLElement>(".fo-sheet-editor-box") as HTMLElement
		const px = Number(/([\d.]+)px/u.exec(box.style.font)?.[1])
		const scale = Number(/scale\(([\d.]+)\)/u.exec(box.style.transform)?.[1])
		const cell = handle.renderer.cellBox(handle.renderer.currentView() as NonNullable<ReturnType<typeof handle.renderer.currentView>>, {
			row: 2,
			col: 1
		})

		expect(model.getSnapshot().editing).not.toBeNull()
		// Calibri 11 at 100% is 14.67 px: laid out at 16, shown at 16 x scale.
		expect(px).toBeGreaterThanOrEqual(16)
		expect(px * scale).toBeCloseTo(14.67, 1)
		expect(Number.parseFloat(box.style.getPropertyValue("--fo-sheet-editor-min-width")) * scale).toBeCloseTo(cell?.width ?? 0, 3)
		expect(box.style.transformOrigin).toBe("top left")
		media.mockRestore()
	})

	it("asks for the menu after a long press, selecting the cell unless the selection holds it, and the release is no tap", async () => {
		const { scroller, model, handle, menu } = await mount()

		act(() =>
			model.select({
				...cellSelection({ row: 0, col: 0 }, []),
				focus: { row: 2, col: 2 },
				ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }]
			})
		)

		const inside = cellCenter(handle, 1, 1)

		pointer(scroller, "pointerdown", inside)
		await wait(LONG_PRESS_MS + 50)
		pointer(scroller, "pointerup", inside)

		expect(menu.at(-1)).toBe(true)
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }])

		const outside = cellCenter(handle, 4, 3)

		pointer(scroller, "pointerdown", { ...outside, pointerId: 2 })
		await wait(LONG_PRESS_MS + 50)
		pointer(scroller, "pointerup", { ...outside, pointerId: 2 })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 4, startCol: 3, endRow: 4, endCol: 3 }])
		expect(model.getSnapshot().editing).toBeNull()

		// A finger that moves pans: no long press.
		const count = menu.length

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 6, 1), pointerId: 3 })
		pointer(scroller, "pointermove", { ...cellCenter(handle, 6, 1), clientY: cellCenter(handle, 6, 1).clientY + 30, pointerId: 3 })
		await wait(LONG_PRESS_MS + 50)
		pointer(scroller, "pointercancel", { pointerId: 3 })

		expect(menu.slice(count)).not.toContain(true)
		expect(model.getSnapshot().selection.active).toEqual({ row: 4, col: 3 })
	})

	it("asks for the menu on a tap on the cell that is the selection once no second tap came, and a mouse press puts it away", async () => {
		const { scroller, handle, menu } = await mount()

		tap(scroller, cellCenter(handle, 1, 1))
		await wait(DOUBLE_TAP_MS + 50)

		expect(menu.at(-1)).toBe(false)

		tap(scroller, cellCenter(handle, 1, 1), 2)

		expect(menu.at(-1)).toBe(false)

		await wait(DOUBLE_TAP_MS + 50)

		expect(menu.at(-1)).toBe(true)

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 3, 3), pointerType: "mouse", pointerId: 9 })
		pointer(scroller, "pointerup", { ...cellCenter(handle, 3, 3), pointerType: "mouse", pointerId: 9 })

		expect(menu.at(-1)).toBe(false)
	})

	it("shows the start handle for a touch selection only, and dragging it widens the selection from its end corner", async () => {
		const { scroller, model, handle, root, menu, paint } = await mount()

		tap(scroller, cellCenter(handle, 3, 3))
		paint()

		const element = startHandle(root)

		expect(element.hidden).toBe(false)

		const target = cellCenter(handle, 1, 1)

		pointer(element, "pointerdown", { ...target, pointerId: 4 })
		pointer(element, "pointermove", { ...target, pointerId: 4 })
		pointer(element, "pointerup", { ...target, pointerId: 4 })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 1, startCol: 1, endRow: 3, endCol: 3 }])
		expect(model.getSnapshot().selection.active).toEqual({ row: 3, col: 3 })
		expect(menu.at(-1)).toBe(true)
		expect(live(root)).toBe("D4, B2:D4 selected")

		// A key is no finger's.
		act(() => {
			scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
		})
		paint()

		expect(startHandle(root).hidden).toBe(true)
		expect(menu.at(-1)).toBe(false)
	})

	it("opens the entry from the handle's editActive, and refuses it read-only", async () => {
		const { model, handle } = await mount()

		let opened = false

		act(() => {
			opened = handle.editActive()
		})

		expect(opened).toBe(true)
		expect(document.activeElement).toBe(document.querySelector("textarea.fo-sheet-editor"))

		act(() => model.cancelEditing())
		act(() => model.setReadOnly(true))
		act(() => {
			opened = handle.editActive()
		})

		expect(opened).toBe(false)
		expect(document.querySelector("textarea.fo-sheet-editor")).toBeNull()
	})
})

describe("SheetGrid scrolling past the browsers' range", () => {
	function wheel(scroller: HTMLElement, init: WheelEventInit): boolean {
		let taken = false

		act(() => {
			const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })

			// The DOM in the tests drops a wheel's modifier keys from its init.
			if (init.ctrlKey === true) Object.defineProperty(event, "ctrlKey", { value: true })

			scroller.dispatchEvent(event)
			taken = event.defaultPrevented
		})

		return taken
	}

	it("leaves a wheel to the browser on a sheet it can scroll itself, and takes it in the sheet's own pixels past that", async () => {
		const { scroller, handle, paint } = await mount()

		expect(wheel(scroller, { deltaY: 100 })).toBe(false)

		act(() => handle.goTo({ row: SHEET_MAX_ROWS - 1, col: 0 }))
		paint()

		const before = handle.renderer.currentView()?.rows.scroll ?? 0

		expect(wheel(scroller, { deltaY: -100 })).toBe(true)
		expect((handle.renderer.currentView()?.rows.scroll ?? 0) - before).toBe(-100)

		// Lines, as Firefox sends a mouse wheel's steps: a row at the default height each.
		const rowHeight = handle.renderer.currentView()?.rows.axis.defaultSize ?? 0
		const lines = handle.renderer.currentView()?.rows.scroll ?? 0

		expect(wheel(scroller, { deltaY: -3, deltaMode: 1 })).toBe(true)
		expect(lines - (handle.renderer.currentView()?.rows.scroll ?? 0)).toBe(3 * rowHeight)

		// A pinch stays the page's.
		expect(wheel(scroller, { deltaY: -100, ctrlKey: true })).toBe(false)
	})
})

describe("SheetGrid panned by a finger on a sheet past the browsers' range", () => {
	function touch(scroller: HTMLElement, type: "touchstart" | "touchend", fingers: number): void {
		act(() => {
			const event = new Event(type, { bubbles: true })

			Object.defineProperty(event, "touches", { value: { length: fingers } })
			scroller.dispatchEvent(event)
		})
	}

	function scrollTo(scroller: HTMLElement, top: number): void {
		act(() => {
			scroller.scrollTop = top
			scroller.dispatchEvent(new Event("scroll"))
		})
	}

	it("moves the sheet by the pixels the finger moves, and maps the scrollbar again once the pan has settled", async () => {
		const { scroller, handle, paint } = await mount()

		act(() => handle.goTo({ row: 500_000, col: 0 }))
		paint()

		const scrolled = (): number => handle.renderer.currentView()?.rows.scroll ?? 0
		const start = scrolled()
		const domStart = scroller.scrollTop

		touch(scroller, "touchstart", 1)
		scrollTo(scroller, domStart + 100)
		paint()
		scrollTo(scroller, domStart + 400)
		paint()

		expect(scrolled() - start).toBe(400)

		touch(scroller, "touchend", 0)
		scrollTo(scroller, domStart + 420)
		paint()
		// The momentum after the finger lifts is the pan's too.
		expect(scrolled() - start).toBe(420)

		await wait(250)
		paint()

		// Settled: the browser's offset is the scaled one of where the sheet is, and the scrollbar maps by position.
		const view = handle.renderer.currentView()

		if (view === null) throw new Error("no view")

		expect(scrolled() - start).toBe(420)
		expect(Math.abs(scroller.scrollTop - toDom(view.rows.scroll, bodyTotal(view.rows), view.rows.bodyView))).toBeLessThan(1)
	})

	// A sheet used to its last rows: its whole height is scaled into the browser's range, and stays so.
	const TALL = buildFixture({
		sheets: [
			{
				name: "Tall",
				body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048000"><c r="A1048000"><v>2</v></c></row></sheetData>'
			}
		]
	})

	it("reaches the first and the last row by pans alone on a sheet used to its end", async () => {
		const { scroller, handle, paint } = await mount({}, TALL)
		const scrolled = (): number => handle.renderer.currentView()?.rows.scroll ?? -1
		const range = (): number => {
			const view = handle.renderer.currentView()

			return view === null ? 0 : bodyTotal(view.rows) - view.rows.bodyView
		}

		act(() => handle.goTo({ row: 120, col: 0 }))
		paint()
		await wait(250)
		paint()
		expect(scrolled()).toBeGreaterThan(0)

		// Panned up past the start: the browser stops at 0, which is the first row.
		touch(scroller, "touchstart", 1)
		scrollTo(scroller, Math.max(0, scroller.scrollTop - 5000))
		paint()
		touch(scroller, "touchend", 0)
		expect(scrolled()).toBe(0)

		// Near the end, once the extent holds every row: the browser's end is the last row.
		act(() => handle.goTo({ row: SHEET_MAX_ROWS - 1, col: 0 }))
		paint()
		act(() => handle.goTo({ row: 1_048_200, col: 0 }))
		paint()
		expect(scrolled()).toBeLessThan(range())

		const end = scroller.scrollTop + 50_000

		touch(scroller, "touchstart", 1)
		scrollTo(scroller, end)
		paint()
		expect(scrolled()).toBe(range())
	})

	it("leaves the sheet where it was after an iOS bounce past the start", async () => {
		const { scroller, handle, paint } = await mount()
		let reported: number | null = null
		const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")

		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			get(this: Element) {
				return reported ?? (native?.get?.call(this) as number)
			},
			set(this: Element, value: number) {
				native?.set?.call(this, value)
			}
		})

		touch(scroller, "touchstart", 1)

		for (const offset of [-10, -40, -80]) {
			reported = offset
			act(() => scroller.dispatchEvent(new Event("scroll")))
		}

		touch(scroller, "touchend", 0)

		for (const offset of [-40, -8, 0]) {
			reported = offset
			act(() => scroller.dispatchEvent(new Event("scroll")))
		}

		reported = null
		await wait(250)
		paint()

		expect(handle.renderer.currentView()?.rows.scroll).toBe(0)
		expect(scroller.scrollTop).toBe(0)
	})

	it("gives the extent back once the view returns near the used rows", async () => {
		const { scroller, handle, paint } = await mount()
		const rows = (): number => handle.renderer.currentView()?.rows.axis.count ?? 0
		const used = rows()

		act(() => handle.goTo({ row: SHEET_MAX_ROWS - 1, col: 0 }))
		paint()
		expect(rows()).toBe(SHEET_MAX_ROWS)

		act(() => handle.goTo({ row: 0, col: 0 }))
		paint()
		scrollTo(scroller, 0)
		await wait(250)
		paint()

		expect(rows()).toBe(used)

		// A finger's pan from the top now moves the sheet by its own pixels, with no scaling left.
		touch(scroller, "touchstart", 1)
		scrollTo(scroller, 200)
		paint()
		expect(handle.renderer.currentView()?.rows.scroll).toBe(200)
	})
})

describe("SheetGrid for a screen reader", () => {
	it("says the active cell alone, and the selection's range once it holds more than one cell and a drag has let go", async () => {
		const { scroller, handle, root, model } = await mount()

		expect(live(root)).toBe("A1 2")

		pointer(scroller, "pointerdown", { ...cellCenter(handle, 0, 1), pointerType: "mouse" })
		pointer(scroller, "pointermove", { ...cellCenter(handle, 1, 1), pointerType: "mouse" })
		pointer(scroller, "pointermove", { ...cellCenter(handle, 1, 2), pointerType: "mouse" })
		// The ranges a drag passes through are not said: only where it settles.
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 1, endRow: 1, endCol: 2 }])
		expect(live(root)).toBe("B1 hello")
		pointer(scroller, "pointerup", { ...cellCenter(handle, 1, 2), pointerType: "mouse" })

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 1, endRow: 1, endCol: 2 }])
		expect(live(root)).toBe("B1 hello, B1:C2 selected")

		const active = document.getElementById(scroller.getAttribute("aria-activedescendant") ?? "")

		expect(active?.getAttribute("aria-colindex")).toBe("2")
		expect(active?.parentElement?.getAttribute("aria-rowindex")).toBe("1")
		// The hidden input is no cell of the row.
		expect(root.querySelector(".fo-sheet-touch-sink")?.getAttribute("aria-hidden")).toBe("true")
	})
})

describe("SheetGrid on a chartsheet", () => {
	function key(target: Element, init: KeyboardEventInit): void {
		act(() => {
			target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
		})
	}

	it("draws no selection or fill handle, opens no entry, and moves to no cell by key, pointer or finger", async () => {
		const { model, handle, scroller, root, chrome, paint, menu } = await mount(
			{},
			withChartsheet(buildFixture(BASIC), barChart([KEPT]))
		)
		const selectionDrawn = (): boolean => chrome.calls.some(call => call.fill === DEFAULT_THEME.selectionLine)
		const fillHandle = root.querySelector<HTMLElement>(".fo-sheet-fill-handle") as HTMLElement

		chrome.reset()
		paint()

		// A worksheet first: its selection and fill handle show.
		expect(selectionDrawn()).toBe(true)
		expect(fillHandle.hidden).toBe(false)

		const graph = model.getSnapshot().sheets.find(sheet => sheet.kind === "chartsheet")

		if (graph === undefined) throw new Error("no chartsheet")

		act(() => model.setSheet(graph.id))
		await settle()
		chrome.reset()
		paint()

		expect(model.cellless()).toBe(true)
		expect(selectionDrawn()).toBe(false)
		expect(fillHandle.hidden).toBe(true)
		expect(scroller.getAttribute("aria-activedescendant")).toBeNull()
		expect(live(root)).toBe("")

		const before = model.getSnapshot().selection

		key(scroller, { key: "ArrowDown" })
		key(scroller, { key: "x" })
		key(scroller, { key: "F2" })

		expect(model.getSnapshot().selection).toBe(before)
		expect(document.querySelector("textarea.fo-sheet-editor")).toBeNull()

		pointer(scroller, "pointerdown", { clientX: 200, clientY: 100, pointerType: "mouse" })
		pointer(scroller, "pointerup", { clientX: 200, clientY: 100, pointerType: "mouse" })
		tap(scroller, { clientX: 260, clientY: 140 }, 5)
		tap(scroller, { clientX: 260, clientY: 140 }, 6)

		let opened = true

		act(() => {
			opened = handle.editActive()
		})

		expect(model.getSnapshot().selection).toBe(before)
		expect(opened).toBe(false)
		expect(document.querySelector("textarea.fo-sheet-editor")).toBeNull()
		expect(startHandle(root).hidden).toBe(true)

		// A finger's long press and a tap on the active cell ask for no cell menu.
		const asked = menu.length

		pointer(scroller, "pointerdown", { clientX: 220, clientY: 120, pointerId: 8 })
		await wait(LONG_PRESS_MS + 50)
		pointer(scroller, "pointerup", { clientX: 220, clientY: 120, pointerId: 8 })
		tap(scroller, { clientX: 220, clientY: 120 }, 9)
		await wait(DOUBLE_TAP_MS + 50)

		expect(menu.slice(asked)).not.toContain(true)
		expect(fillHandle.hidden).toBe(true)

		// The workbook's keys still work: Ctrl+Page Up goes back to the worksheet.
		key(scroller, { key: "PageUp", code: "PageUp", ctrlKey: true })
		await settle()

		expect(model.cellless()).toBe(false)
	})
})
