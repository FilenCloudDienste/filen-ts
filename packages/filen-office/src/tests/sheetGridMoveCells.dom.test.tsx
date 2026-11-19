// @vitest-environment happy-dom
import { act } from "react"
import { describe, expect, it } from "vitest"
import type { SheetCommand } from "../core/sheet/protocol"
import type { SheetGridHandle, SheetGridModel, SheetGridProps } from "../react/sheet/index"
import { LONG_PRESS_MS } from "../react/sheet/touch/gestures"
import { type MountedGrid, mountGrid, pointer, registerSheetGridDom, settleGrid } from "./sheetGridDomFixtures.dom"
import { BASIC, buildFixture } from "./sheetSessionFixtures"

// Dragging the selection by its border in the grid: the move cursor over the border, a drag moving the block (Ctrl
// copying it, Shift inserting it at the nearest gridline, the keys read as the pointer lets go), a drop over data
// asking first, Esc cancelling, and a finger dragging after a long press on the selection.

registerSheetGridDom()

// The grid's own element as the root.
type Mounted = Omit<MountedGrid, "root"> & { readonly root: HTMLElement }

async function mount(props: Partial<SheetGridProps> = {}): Promise<Mounted> {
	const mounted = await mountGrid({ bytes: buildFixture(BASIC), recordCommands: true, props: { mac: false, ...props } })

	return { ...mounted, root: mounted.sheet }
}

function box(handle: SheetGridHandle, row: number, col: number): { x: number; y: number; width: number; height: number } {
	const rect = handle.cellRect({ row, col })

	if (rect === null) throw new Error("off screen")

	return rect
}

function center(handle: SheetGridHandle, row: number, col: number): { clientX: number; clientY: number } {
	const rect = box(handle, row, col)

	return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
}

// On the right edge of a cell's outline.
function rightEdge(handle: SheetGridHandle, row: number, col: number): { clientX: number; clientY: number } {
	const rect = box(handle, row, col)

	return { clientX: rect.x + rect.width - 1, clientY: rect.y + rect.height / 2 }
}

function selectCell(model: SheetGridModel, row: number, col: number): void {
	act(() => {
		model.select({
			active: { row, col },
			anchor: { row, col },
			focus: { row, col },
			ranges: [{ startRow: row, startCol: col, endRow: row, endCol: col }]
		})
	})
}

function moves(commands: readonly SheetCommand[]): SheetCommand[] {
	return commands.filter(command => command.type === "cells.move")
}

async function drag(
	mounted: Mounted,
	from: { clientX: number; clientY: number },
	to: { clientX: number; clientY: number },
	keys: PointerEventInit = {}
): Promise<void> {
	pointer(mounted.scroller, "pointerdown", { ...from, ...keys })
	pointer(mounted.scroller, "pointermove", { ...to, ...keys, buttons: 1 })
	pointer(mounted.scroller, "pointerup", { ...to, ...keys })
	await settleGrid()
}

describe("the selection's border", () => {
	it("shows the move cursor over the border, none inside the cell", async () => {
		const { model, handle, scroller, root } = await mount()

		selectCell(model, 0, 0)
		pointer(scroller, "pointermove", { ...rightEdge(handle, 0, 0), buttons: 0 })
		expect(root.dataset["cursor"]).toBe("move")
		pointer(scroller, "pointermove", { ...center(handle, 0, 0), buttons: 0 })
		expect(root.dataset["cursor"]).toBe("")
	})

	it("drags the block to where the pointer lets go, and selects it there", async () => {
		const mounted = await mount()
		const { model, handle } = mounted

		selectCell(model, 0, 0)
		await drag(mounted, rightEdge(handle, 0, 0), center(handle, 4, 4))
		expect(moves(mounted.commands)).toEqual([
			{
				type: "cells.move",
				sheet: 0,
				range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
				to: { row: 4, col: 4 },
				copy: false,
				active: { row: 0, col: 0 }
			}
		])
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 4, startCol: 4, endRow: 4, endCol: 4 }])
		expect(model.getSnapshot().state.canUndo).toBe(true)
	})

	it("copies with Ctrl and inserts with Shift at the nearest gridline, as the keys are when the pointer lets go", async () => {
		const mounted = await mount()
		const { model, handle } = mounted

		selectCell(model, 1, 1)
		await drag(mounted, rightEdge(handle, 1, 1), center(handle, 5, 5), { ctrlKey: true })

		const near = box(handle, 6, 3)

		selectCell(model, 1, 1)
		await drag(mounted, rightEdge(handle, 1, 1), { clientX: near.x + near.width / 2, clientY: near.y + 2 }, { shiftKey: true })
		expect(moves(mounted.commands).map(command => command.type === "cells.move" && [command.copy, command.insert, command.to])).toEqual(
			[
				[true, undefined, { row: 5, col: 5 }],
				[false, "rows", { row: 6, col: 3 }]
			]
		)
	})

	it("asks before replacing data and sends the move again when agreed", async () => {
		const asked: (() => void)[] = []
		const mounted = await mount({ onConfirmReplace: replace => asked.push(replace) })
		const { model, handle } = mounted

		selectCell(model, 0, 0)
		// B1 holds text.
		await drag(mounted, rightEdge(handle, 0, 0), center(handle, 0, 1))
		expect(asked).toHaveLength(1)
		act(() => asked[0]?.())
		await settleGrid()
		expect(moves(mounted.commands).map(command => command.type === "cells.move" && command.replace)).toEqual([undefined, true])
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 1, endRow: 0, endCol: 1 }])
	})

	it("cancels on Esc, and a press inside the cell selects as before", async () => {
		const mounted = await mount()
		const { model, handle, scroller } = mounted

		selectCell(model, 0, 0)
		pointer(scroller, "pointerdown", rightEdge(handle, 0, 0))
		pointer(scroller, "pointermove", { ...center(handle, 3, 3), buttons: 1 })
		act(() => {
			scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
		})
		pointer(scroller, "pointerup", center(handle, 3, 3))
		await settleGrid()
		expect(moves(mounted.commands)).toEqual([])
		await drag(mounted, center(handle, 0, 0), center(handle, 2, 0))
		expect(moves(mounted.commands)).toEqual([])
		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 0 }])
	})

	it("drags by a finger after a long press on the selection", async () => {
		const mounted = await mount()
		const { model, handle, scroller } = mounted

		selectCell(model, 0, 0)
		pointer(scroller, "pointerdown", { ...center(handle, 0, 0), pointerType: "touch" })
		await act(() => new Promise(resolve => setTimeout(resolve, LONG_PRESS_MS + 20)))
		pointer(scroller, "pointermove", { ...center(handle, 3, 2), pointerType: "touch", buttons: 1 })
		pointer(scroller, "pointerup", { ...center(handle, 3, 2), pointerType: "touch" })
		await settleGrid()
		expect(moves(mounted.commands).map(command => command.type === "cells.move" && command.to)).toEqual([{ row: 3, col: 2 }])
	})
})
