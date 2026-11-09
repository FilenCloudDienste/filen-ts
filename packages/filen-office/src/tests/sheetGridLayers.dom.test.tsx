// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CellFlag, type SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import {
	SheetGrid,
	SheetGridModel,
	type GridDecoration,
	type SheetCellPointer,
	type SheetEntryVerdict,
	type SheetGridExtension,
	type SheetGridHandle
} from "../react/sheet/index"
import { RecordingCanvas } from "./sheetGridCanvas"
import { IMMEDIATE, buildFixture, firstTile, tileEntry } from "./sheetSessionFixtures"
import { sheetBody } from "./sheetKeysFixtures"

// The grid's fill handle (drag out to fill, back in to clear, Escape to cancel) and its extension points as a feature
// meets them: a press an extension takes selects nothing, hover and leave arrive once per cell, decorators paint,
// overlays render over the cells and find their cells' boxes.

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
	readonly container: HTMLElement
	readonly scroller: HTMLElement
	readonly fill: HTMLElement
	readonly commands: SheetCommand[]
	paint(): void
}

const BODY = sheetBody([[1], [2], ["Mon"]])

async function mount(extensions?: readonly SheetGridExtension[], children?: ReactNode): Promise<Mounted> {
	const host = inThreadSheetHost()
	const opened = await host.open(
		buildFixture({ sheets: [{ name: "S", body: BODY }] }),
		{ kind: "xlsx", slicing: IMMEDIATE },
		() => undefined
	)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ session: opened.session, info: opened.info })
	const commands: SheetCommand[] = []
	const command = model.command.bind(model)

	vi.spyOn(model, "command").mockImplementation((sent, report) => {
		commands.push(sent)

		return command(sent, report)
	})

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
				{...(extensions !== undefined && { extensions })}
			>
				{children}
			</SheetGrid>
		)
	})
	await settle()

	const handle = ref.current as SheetGridHandle
	const paint = (): void => {
		act(() => handle.renderer.paint())
	}

	paint()
	await settle()
	paint()

	return {
		model,
		handle,
		container,
		scroller: container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement,
		fill: container.querySelector<HTMLElement>(".fo-sheet-fill-handle") as HTMLElement,
		commands,
		paint
	}
}

function pointer(target: Element, type: string, init: PointerEventInit): void {
	act(() => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, ...init })
		)
	})
}

function center(handle: SheetGridHandle, row: number, col: number): { clientX: number; clientY: number } {
	const box = handle.cellRect({ row, col })

	if (box === null) throw new Error("off screen")

	return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
}

function select(mounted: Mounted, startRow: number, endRow: number): void {
	act(() => {
		mounted.model.select({
			active: { row: startRow, col: 0 },
			anchor: { row: startRow, col: 0 },
			focus: { row: endRow, col: 0 },
			ranges: [{ startRow, startCol: 0, endRow, endCol: 0 }]
		})
	})
	mounted.paint()
}

async function shown(model: SheetGridModel, row: number): Promise<string> {
	return tileEntry(await firstTile(model.session, 0), row, 0)?.text ?? ""
}

describe("the fill handle", () => {
	it("sits on the selection's corner and fills what it is dragged over", async () => {
		const mounted = await mount()

		select(mounted, 0, 1)

		const corner = mounted.handle.cellRect({ row: 1, col: 0 })

		expect(mounted.fill.hidden).toBe(false)
		expect(mounted.fill.style.transform).toBe(
			`translate(${String((corner?.x ?? 0) + (corner?.width ?? 0))}px, ${String((corner?.y ?? 0) + (corner?.height ?? 0))}px)`
		)

		pointer(mounted.fill, "pointerdown", center(mounted.handle, 1, 0))
		pointer(mounted.fill, "pointermove", center(mounted.handle, 4, 0))
		pointer(mounted.fill, "pointerup", center(mounted.handle, 4, 0))
		await settle()

		expect(mounted.commands.at(-1)).toEqual({
			type: "fill.auto",
			sheet: 0,
			source: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
			target: { startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
			mode: "auto"
		})
		expect([await shown(mounted.model, 3), await shown(mounted.model, 4)]).toEqual(["4", "5"])
		expect(mounted.model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }])
	})

	it("fills a copy with Ctrl held, clears what it is dragged back over, and does nothing on Escape", async () => {
		const mounted = await mount()

		select(mounted, 0, 1)
		pointer(mounted.fill, "pointerdown", center(mounted.handle, 1, 0))
		pointer(mounted.fill, "pointermove", center(mounted.handle, 3, 0))
		pointer(mounted.fill, "pointerup", { ...center(mounted.handle, 3, 0), ctrlKey: true })
		await settle()

		expect(mounted.commands.at(-1)).toMatchObject({ type: "fill.auto", mode: "alternate" })

		select(mounted, 0, 2)
		pointer(mounted.fill, "pointerdown", center(mounted.handle, 2, 0))
		pointer(mounted.fill, "pointermove", center(mounted.handle, 1, 0))
		pointer(mounted.fill, "pointerup", center(mounted.handle, 1, 0))
		await settle()

		expect(mounted.commands.at(-1)).toEqual({
			type: "cells.clear",
			sheet: 0,
			ranges: [{ startRow: 2, startCol: 0, endRow: 2, endCol: 0 }],
			what: "contents"
		})
		expect(await shown(mounted.model, 2)).toBe("")

		const sent = mounted.commands.length

		pointer(mounted.fill, "pointerdown", center(mounted.handle, 1, 0))
		pointer(mounted.fill, "pointermove", center(mounted.handle, 6, 0))
		act(() => {
			mounted.scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
		})
		pointer(mounted.fill, "pointerup", center(mounted.handle, 6, 0))
		await settle()

		expect(mounted.commands.length).toBe(sent)
	})

	it("hides while an entry is open and for whole columns", async () => {
		const mounted = await mount()

		select(mounted, 0, 0)
		act(() => {
			mounted.model.startEditing("x", "enter")
		})

		expect(mounted.fill.hidden).toBe(true)

		act(() => {
			mounted.model.cancelEditing()
			mounted.model.select({
				active: { row: 0, col: 0 },
				anchor: { row: 0, col: 0 },
				focus: { row: 1_048_575, col: 0 },
				ranges: [{ startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 0 }]
			})
		})
		mounted.paint()

		expect(mounted.fill.hidden).toBe(true)
	})
})

describe("grid extensions", () => {
	it("take a press before the grid selects, and follow it as a drag", async () => {
		const heard: string[] = []
		const extension: SheetGridExtension = {
			id: "probe",
			pointer: event => {
				if (event.kind !== "down") return undefined

				heard.push(`down ${String(event.row)}`)

				return event.ctrlKey
					? { move: point => heard.push(`move ${String(point.row)}`), end: commit => heard.push(`end ${String(commit)}`) }
					: undefined
			}
		}
		const mounted = await mount([extension])

		select(mounted, 0, 0)
		pointer(mounted.scroller, "pointerdown", { ...center(mounted.handle, 2, 0), ctrlKey: true })
		pointer(mounted.scroller, "pointermove", center(mounted.handle, 3, 0))
		pointer(mounted.scroller, "pointerup", center(mounted.handle, 3, 0))

		expect(heard).toEqual(["down 2", "move 3", "end true"])
		expect(mounted.model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })

		// Not taken: the grid selects.
		pointer(mounted.scroller, "pointerdown", center(mounted.handle, 2, 0))
		pointer(mounted.scroller, "pointerup", center(mounted.handle, 2, 0))

		expect(mounted.model.getSnapshot().selection.active).toEqual({ row: 2, col: 0 })
	})

	it("hear hover once per cell and leave off the cells", async () => {
		const heard: SheetCellPointer[] = []
		const mounted = await mount([{ id: "hover", pointer: event => void heard.push(event) }])
		const a2 = center(mounted.handle, 1, 0)

		pointer(mounted.scroller, "pointermove", { ...a2, buttons: 0 })
		pointer(mounted.scroller, "pointermove", { clientX: a2.clientX + 1, clientY: a2.clientY, buttons: 0 })
		pointer(mounted.scroller, "pointermove", { ...center(mounted.handle, 2, 0), buttons: 0 })
		act(() => {
			mounted.scroller.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1, relatedTarget: document.body }))
		})

		expect(heard.map(event => (event.kind === "leave" ? "leave" : `${event.kind} ${String(event.row)}`))).toEqual([
			"hover 1",
			"hover 2",
			"leave"
		])
	})

	it("decorate flagged cells, render overlays and report frames", async () => {
		const seen: GridDecoration[] = []
		const frames = vi.fn()
		const extension: SheetGridExtension = {
			id: "marks",
			decorators: [{ id: "numbers", mask: CellFlag.NUMBER, phase: "over", paint: (_canvas, cell) => void seen.push(cell) }]
		}
		const mounted = await mount([extension], <span data-testid="overlay">note</span>)
		const stop = mounted.handle.onFrame(frames)

		// Marked whenever the cells were drawn (a frame with nothing new leaves them as drawn).
		mounted.paint()
		stop()

		expect([...new Set(seen.map(cell => cell.row))].sort()).toEqual([0, 1])

		mounted.paint()

		expect(frames).toHaveBeenCalledTimes(1)
		expect(mounted.container.querySelector(".fo-sheet-overlays [data-testid=overlay]")?.textContent).toBe("note")
		expect(mounted.handle.clientRect({ row: 0, col: 0 })).toBeInstanceOf(DOMRect)
	})

	it("check an entry before it is written: a new text, a reopened entry, a dropped one", async () => {
		const verdicts: SheetEntryVerdict[] = [{ text: "checked" }, "edit", "discard"]
		const seen: string[] = []
		const mounted = await mount([
			{
				id: "validation",
				entry: entry => {
					seen.push(entry.text)

					return Promise.resolve(verdicts.shift() ?? "commit")
				}
			}
		])

		select(mounted, 4, 4)
		act(() => {
			mounted.model.startEditing("typed", "enter")
		})
		await act(() => mounted.model.commitEditing(null))
		await settle()

		expect(mounted.commands.at(-1)).toMatchObject({ type: "cells.set", cells: { inputs: ["checked"] } })

		act(() => {
			mounted.model.startEditing("again", "enter")
		})

		let written = true

		await act(async () => {
			written = await mounted.model.commitEditing({ ...mounted.model.getSnapshot().selection, active: { row: 6, col: 0 } })
		})

		expect(written).toBe(false)
		expect(mounted.model.getSnapshot().editing).toMatchObject({ row: 4, col: 0, text: "again", mode: "edit" })

		const sent = mounted.commands.length

		await act(() => mounted.model.commitEditing(null))

		expect(mounted.commands.length).toBe(sent)
		expect(mounted.model.getSnapshot().editing).toBeNull()
		expect(seen).toEqual(["typed", "again", "again"])
	})

	it("lay a cell's text out after a decorator's inset", async () => {
		const inset: SheetGridExtension = {
			id: "icons",
			decorators: [{ id: "icon", mask: CellFlag.NUMBER, phase: "over", inset: 40, paint: () => undefined }]
		}
		const plain = await mount()
		const decorated = await mount([inset])
		const textX = (mounted: Mounted): number | undefined => {
			const canvas = canvases.get(mounted.container.querySelector("canvas") as HTMLCanvasElement)

			return canvas?.calls.find(call => call.op === "fillText" && call.args[0] === "Mon")?.args[1] as number | undefined
		}

		// "Mon" is text (no NUMBER flag): not moved; a number left-aligned would be.
		expect(textX(decorated)).toBe(textX(plain))

		act(() => {
			void decorated.model.command({
				type: "format.apply",
				sheet: 0,
				ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
				patch: { align: "left" }
			})
		})
		await settle()
		decorated.paint()

		const canvas = canvases.get(decorated.container.querySelector("canvas") as HTMLCanvasElement)
		const one = canvas?.calls.filter(call => call.op === "fillText" && call.args[0] === "1").at(-1)
		const box = decorated.handle.cellRect({ row: 0, col: 0 })

		expect((one?.args[1] as number) - (box?.x ?? 0)).toBeGreaterThanOrEqual(40)
	})
})
