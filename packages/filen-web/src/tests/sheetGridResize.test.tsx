// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { gridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from "@/features/spreadsheet/lib/model"
import type { Selection } from "@/features/spreadsheet/lib/cellRef.logic"
import { mockSheetView } from "@/tests/mockSheetView"

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })
	HTMLElement.prototype.setPointerCapture = vi.fn()
	HTMLElement.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
	vi.useRealTimers()
})

const ORIGIN: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }

function renderGrid(
	onResize: (axis: string, sizes: readonly (readonly [number, number | null])[]) => Promise<void>,
	view = mockSheetView(),
	selection = ORIGIN
) {
	return render(
		<SheetGrid
			sheet={gridSheet(view)}
			styles={[]}
			selection={selection}
			onSelectionChange={() => undefined}
			label="t.xlsx"
			onResize={onResize}
		/>
	)
}

function columnHeader(container: HTMLElement, col: number): HTMLElement {
	const header = container.querySelector<HTMLElement>(`[role="columnheader"][aria-colindex="${String(col + 2)}"]`)

	if (header === null) throw new Error("no header")

	return header
}

function handleOf(header: HTMLElement): HTMLElement {
	const handle = header.querySelector<HTMLElement>("[data-resize-handle]")

	if (handle === null) throw new Error("no handle")

	return handle
}

function drag(handle: HTMLElement, fromX: number, toX: number): void {
	fireEvent.pointerDown(handle, { pointerId: 1, clientX: fromX, clientY: 0, button: 0 })
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: toX, clientY: 0 })
	act(() => {
		vi.advanceTimersToNextFrame()
	})
}

describe("SheetGrid resize", () => {
	it("resizes a column live, shows its size, and commits once on release", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		drag(handle, 100, 150)

		expect(columnHeader(container, 1).style.width).toBe(`${String(DEFAULT_COL_WIDTH + 50)}px`)
		expect(screen.getByRole("status").textContent).toBe(`Width: ${String(DEFAULT_COL_WIDTH + 50)} px`)
		expect(onResize).not.toHaveBeenCalled()

		await act(() => {
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 150, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenCalledTimes(1)
		expect(onResize).toHaveBeenCalledWith("cols", [[1, DEFAULT_COL_WIDTH + 50]])
	})

	it("cancels on Escape without closing anything around it", () => {
		const onResize = vi.fn(() => Promise.resolve())
		const outer = vi.fn()

		document.addEventListener("keydown", outer)

		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		drag(handle, 100, 150)
		fireEvent.keyDown(window, { key: "Escape" })
		fireEvent.pointerUp(handle, { pointerId: 1, clientX: 150, clientY: 0 })

		expect(onResize).not.toHaveBeenCalled()
		expect(outer).not.toHaveBeenCalled()
		expect(columnHeader(container, 1).style.width).toBe(`${String(DEFAULT_COL_WIDTH)}px`)
		document.removeEventListener("keydown", outer)
	})

	it("cancels on Escape pressed before the first move", () => {
		const onResize = vi.fn(() => Promise.resolve())
		const outer = vi.fn()

		document.addEventListener("keydown", outer)

		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 0, button: 0 })
		fireEvent.keyDown(document.body, { key: "Escape" })
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150, clientY: 0 })
		act(() => {
			vi.advanceTimersToNextFrame()
		})
		fireEvent.pointerUp(handle, { pointerId: 1, clientX: 150, clientY: 0 })

		expect(onResize).not.toHaveBeenCalled()
		expect(outer).not.toHaveBeenCalled()
		expect(columnHeader(container, 1).style.width).toBe(`${String(DEFAULT_COL_WIDTH)}px`)
		document.removeEventListener("keydown", outer)
	})

	it("stops listening for Escape once the drag ends", () => {
		const onResize = vi.fn(() => Promise.resolve())
		const outer = vi.fn()

		document.addEventListener("keydown", outer)

		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		drag(handle, 100, 150)
		fireEvent.pointerCancel(handle, { pointerId: 1 })
		fireEvent.keyDown(document.body, { key: "Escape" })

		expect(outer).toHaveBeenCalledTimes(1)
		document.removeEventListener("keydown", outer)
	})

	it("cancels on pointercancel", () => {
		const onResize = vi.fn(() => Promise.resolve())
		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		drag(handle, 100, 150)
		fireEvent.pointerCancel(handle, { pointerId: 1 })

		expect(onResize).not.toHaveBeenCalled()
		expect(screen.queryByRole("status")).toBeNull()
	})

	it("resizes every selected column of a whole-column selection", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const selection: Selection = { anchor: { row: 0, col: 1 }, focus: { row: 1_048_575, col: 3 } }
		const { container } = renderGrid(onResize, mockSheetView(), selection)
		const handle = handleOf(columnHeader(container, 2))

		drag(handle, 0, 20)
		await act(() => {
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenCalledWith("cols", [
			[1, DEFAULT_COL_WIDTH + 20],
			[2, DEFAULT_COL_WIDTH + 20],
			[3, DEFAULT_COL_WIDTH + 20]
		])
	})

	it("moves a frozen column's edge and the body with it", () => {
		const { container } = renderGrid(() => Promise.resolve(), mockSheetView({ frozenCols: 1 }))
		const grid = container.querySelector<HTMLElement>(".grid")

		drag(handleOf(columnHeader(container, 0)), 0, 30)

		expect(grid?.style.gridTemplateColumns).toContain(`${String(DEFAULT_COL_WIDTH + 30)}px`)
	})

	it("keeps the draft on show until the commit settles", async () => {
		let settle: () => void = () => undefined
		const onResize = vi.fn(
			() =>
				new Promise<void>(resolve => {
					settle = resolve
				})
		)
		const { container } = renderGrid(onResize)
		const handle = handleOf(columnHeader(container, 1))

		drag(handle, 0, 40)
		await act(() => {
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40, clientY: 0 })

			return Promise.resolve()
		})

		expect(columnHeader(container, 1).style.width).toBe(`${String(DEFAULT_COL_WIDTH + 40)}px`)

		await act(() => {
			settle()

			return Promise.resolve()
		})

		expect(screen.queryByRole("status")).toBeNull()
	})

	it("resizes rows from the row rail", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const { container } = renderGrid(onResize)
		const header = container.querySelector<HTMLElement>('[role="rowheader"]')

		if (header === null) throw new Error("no row header")

		const handle = handleOf(header)

		fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 10, button: 0 })
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0, clientY: 40 })
		act(() => {
			vi.advanceTimersToNextFrame()
		})
		await act(() => {
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0, clientY: 40 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenCalledWith("rows", [[0, DEFAULT_ROW_HEIGHT + 30]])
	})

	it("keeps an open cell editor over its cell at the new width", () => {
		const { container } = render(
			<SheetGrid
				sheet={gridSheet(mockSheetView())}
				styles={[]}
				selection={{ anchor: { row: 0, col: 1 }, focus: { row: 0, col: 1 } }}
				onSelectionChange={() => undefined}
				label="t.xlsx"
				onResize={() => Promise.resolve()}
				editor={{ row: 0, col: 1, node: <input aria-label="edit" /> }}
			/>
		)

		drag(handleOf(columnHeader(container, 1)), 0, 44)

		expect(container.querySelector<HTMLElement>("[data-cell-editor]")?.style.minWidth).toBe(`${String(DEFAULT_COL_WIDTH + 44)}px`)
	})

	// Clicking a column header selects its used rows only (to the last filled row), never the grid's blank tail.
	it("resizes every column of a header selection, which spans the used rows", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const selection: Selection = { anchor: { row: 0, col: 1 }, focus: { row: 4, col: 3 } }
		const { container } = renderGrid(onResize, mockSheetView(), selection)
		const handle = handleOf(columnHeader(container, 2))

		drag(handle, 0, 20)
		await act(() => {
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenCalledWith("cols", [
			[1, DEFAULT_COL_WIDTH + 20],
			[2, DEFAULT_COL_WIDTH + 20],
			[3, DEFAULT_COL_WIDTH + 20]
		])
	})

	// A multi-column drag moves the dragged header itself, which can scroll out of the drawn window and
	// unmount, taking pointer capture with it: the gesture must still finish from wherever the pointer is.
	it("finishes a drag whose pointer events reach only the window", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const { container } = renderGrid(onResize)

		fireEvent.pointerDown(handleOf(columnHeader(container, 1)), { pointerId: 1, clientX: 0, clientY: 0, button: 0 })
		fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 0 })
		act(() => {
			vi.advanceTimersToNextFrame()
		})
		await act(() => {
			fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenCalledWith("cols", [[1, DEFAULT_COL_WIDTH + 30]])
	})

	it("commits nothing for a click that never moved, even on a whole selection", async () => {
		const onResize = vi.fn(() => Promise.resolve())
		const selection: Selection = { anchor: { row: 0, col: 1 }, focus: { row: 4, col: 3 } }
		const { container } = renderGrid(onResize, mockSheetView(), selection)
		const handle = handleOf(columnHeader(container, 2))

		await act(() => {
			fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 0, button: 0 })
			fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).not.toHaveBeenCalled()
	})

	it("lets a drag started while an earlier resize settles run to its end", async () => {
		let settle: () => void = () => undefined
		const onResize = vi
			.fn<(axis: string, sizes: readonly (readonly [number, number | null])[]) => Promise<void>>()
			.mockImplementationOnce(
				() =>
					new Promise<void>(resolve => {
						settle = resolve
					})
			)
			.mockImplementation(() => Promise.resolve())
		const { container } = renderGrid(onResize)
		const first = handleOf(columnHeader(container, 1))

		drag(first, 0, 10)
		await act(() => {
			fireEvent.pointerUp(first, { pointerId: 1, clientX: 10, clientY: 0 })

			return Promise.resolve()
		})

		const second = handleOf(columnHeader(container, 2))

		fireEvent.pointerDown(second, { pointerId: 2, clientX: 0, clientY: 0, button: 0 })
		await act(() => {
			settle()

			return Promise.resolve()
		})
		fireEvent.pointerMove(second, { pointerId: 2, clientX: 25, clientY: 0 })
		act(() => {
			vi.advanceTimersToNextFrame()
		})
		await act(() => {
			fireEvent.pointerUp(second, { pointerId: 2, clientX: 25, clientY: 0 })

			return Promise.resolve()
		})

		expect(onResize).toHaveBeenLastCalledWith("cols", [[2, DEFAULT_COL_WIDTH + 25]])
	})

	it("has no handles without onResize", () => {
		const { container } = render(
			<SheetGrid
				sheet={gridSheet(mockSheetView())}
				styles={[]}
				selection={ORIGIN}
				onSelectionChange={() => undefined}
				label="t.xlsx"
			/>
		)

		expect(container.querySelector("[data-resize-handle]")).toBeNull()
	})
})
