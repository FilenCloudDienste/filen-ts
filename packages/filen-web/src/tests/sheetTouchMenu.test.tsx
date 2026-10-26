// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { cellSelection, type SheetGridHandle, type SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import type { SheetClipboardCommands } from "@/features/spreadsheet/clipboard/useSheetClipboard"
import { touchMenuPlace } from "@/features/spreadsheet/touch/sheetTouchMenu.logic"
import { useSheetTouch, type SheetTouch } from "@/features/spreadsheet/touch/useSheetTouch"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"

// The touch menu over the selection: placed above it (below with no room), named items as the DOCX editor's (Cut,
// Copy, Paste, Select all) plus Edit, shown only for the selection it was asked for, the clipboard through its API
// with a toast when the browser blocks it, and a finger's long press kept from the grid's context menu.

const toastError = vi.fn()

vi.mock("sonner", () => ({
	toast: {
		error: (message: string) => {
			toastError(message)
		}
	}
}))

describe("where the touch menu goes", () => {
	it("goes above the selection, below it when there is no room, and stays inside the grid", () => {
		const menu = { width: 300, height: 44 }
		const area = { width: 800, height: 400 }

		expect(touchMenuPlace({ x: 300, y: 200, width: 80, height: 20 }, menu, area)).toEqual({ x: 190, y: 146 })
		expect(touchMenuPlace({ x: 300, y: 20, width: 80, height: 20 }, menu, area).y).toBeGreaterThan(40)
		expect(touchMenuPlace({ x: 0, y: 200, width: 40, height: 20 }, menu, area).x).toBe(8)
		expect(touchMenuPlace({ x: 780, y: 200, width: 20, height: 20 }, menu, area).x).toBe(492)
	})
})

function gridHandle(edit: () => boolean, focus: () => void): SheetGridHandle {
	return {
		rangeRect: () => ({ x: 100, y: 200, width: 64, height: 20 }),
		clientRect: () => new DOMRect(110, 230, 64, 20),
		onFrame: () => () => undefined,
		editActive: edit,
		focus
	} as unknown as SheetGridHandle
}

function Touch({
	grid,
	canEdit,
	handle,
	clipboard,
	onTouch
}: {
	grid: SheetGridState
	canEdit: boolean
	handle: SheetGridHandle
	clipboard: SheetClipboardCommands
	onTouch: (touch: SheetTouch) => void
}) {
	const touch = useSheetTouch({ grid, gridRef: { current: handle }, canEdit, clipboard })

	onTouch(touch)

	return (
		<div
			data-testid="wrapper"
			{...touch.wrapper}
		>
			<div style={{ position: "relative", width: 800, height: 400 }}>{touch.overlay}</div>
		</div>
	)
}

async function mount(canEdit: boolean) {
	const model = await openGrid(await workbook([{ name: "One", rows: [[1, 2]] }]), "xlsx")
	const edit = vi.fn(() => true)
	const focus = vi.fn()
	const clipboard = { copy: vi.fn(() => Promise.resolve("done" as const)), paste: vi.fn(() => Promise.resolve("blocked" as const)) }
	const holder: { touch: SheetTouch | null } = { touch: null }

	render(
		<GridHarness model={model}>
			{grid => (
				<Touch
					grid={grid}
					canEdit={canEdit}
					handle={gridHandle(edit, focus)}
					clipboard={clipboard}
					onTouch={next => {
						holder.touch = next
					}}
				/>
			)}
		</GridHarness>
	)

	const ask = (shown: boolean): void => {
		act(() => {
			holder.touch?.onTouchMenu(shown)
		})
	}

	return { model, edit, focus, clipboard, ask, touch: () => holder.touch }
}

describe("the touch menu", () => {
	it("names its items, opens the entry from Edit, and goes when the selection moves", async () => {
		const { model, edit, ask } = await mount(true)

		expect(screen.queryByRole("toolbar")).toBeNull()

		ask(true)

		const menu = screen.getByRole("toolbar", { name: "Selection actions" })
		const names = screen.getAllByRole("button").map(item => item.textContent)

		expect(menu).toBeTruthy()
		expect(names).toEqual([
			preview.previewSheetTouchCut,
			preview.previewSheetTouchCopy,
			preview.previewSheetTouchPaste,
			preview.previewSheetTouchSelectAll,
			preview.previewSheetTouchEdit,
			"⋯"
		])
		expect(screen.getByRole("button", { name: preview.previewSheetTouchMore }).textContent).toBe("⋯")

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetTouchEdit }))

		expect(edit).toHaveBeenCalledOnce()
		expect(screen.queryByRole("toolbar")).toBeNull()

		ask(true)
		act(() => {
			model.select(cellSelection({ row: 3, col: 2 }, []))
		})

		expect(screen.queryByRole("toolbar")).toBeNull()
	})

	it("is one Tab stop whose buttons the arrows, Home and End move between", async () => {
		const { ask } = await mount(true)

		ask(true)

		const toolbar = screen.getByRole("toolbar", { name: "Selection actions" })
		const buttons = screen.getAllByRole("button")
		const stops = (): number[] => buttons.flatMap((button, index) => (button.tabIndex === 0 ? [index] : []))

		expect(stops()).toEqual([0])

		fireEvent.keyDown(toolbar, { key: "ArrowRight" })
		expect(document.activeElement).toBe(buttons[1])
		expect(stops()).toEqual([1])

		fireEvent.keyDown(toolbar, { key: "End" })
		expect(document.activeElement).toBe(buttons[buttons.length - 1])

		fireEvent.keyDown(toolbar, { key: "ArrowRight" })
		expect(document.activeElement).toBe(buttons[0])

		fireEvent.keyDown(toolbar, { key: "ArrowLeft" })
		expect(document.activeElement).toBe(buttons[buttons.length - 1])

		fireEvent.keyDown(toolbar, { key: "Home" })
		expect(document.activeElement).toBe(buttons[0])
		expect(stops()).toEqual([0])
	})

	it("copies and pastes through the clipboard's API, says when the browser blocks it, and selects the whole sheet", async () => {
		const { model, clipboard, ask } = await mount(true)

		ask(true)
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetTouchCopy }))

		expect(clipboard.copy).toHaveBeenCalledWith(false)

		ask(true)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetTouchPaste }))
			await Promise.resolve()
		})

		expect(clipboard.paste).toHaveBeenCalledOnce()
		expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/clipboard was blocked\. Use (Ctrl\+|⌘)V instead/))

		ask(true)
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetTouchSelectAll }))

		expect(model.getSnapshot().selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 16_383 }])
	})

	it("offers only Copy and Select all read-only", async () => {
		const { ask } = await mount(false)

		ask(true)

		expect(screen.getAllByRole("button").map(item => item.textContent)).toEqual([
			preview.previewSheetTouchCopy,
			preview.previewSheetTouchSelectAll,
			"⋯"
		])
	})

	it("keeps a finger's long press from the grid's context menu, and leaves a mouse's right click to it", async () => {
		await mount(true)

		const wrapper = screen.getByTestId("wrapper")

		fireEvent.pointerDown(wrapper, { pointerType: "touch" })

		const touched = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })

		wrapper.dispatchEvent(touched)

		expect(touched.defaultPrevented).toBe(true)

		fireEvent.pointerDown(wrapper, { pointerType: "mouse" })

		const clicked = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })

		wrapper.dispatchEvent(clicked)

		expect(clicked.defaultPrevented).toBe(false)
	})

	it("opens the grid's full menu from ⋯ at the active cell, with finger-sized items until it closes", async () => {
		const { ask, touch } = await mount(true)
		const wrapper = screen.getByTestId("wrapper")
		const opened: { x: number; y: number; prevented: boolean }[] = []

		// The grid menu's trigger round the wrapper hears the contextmenu the item sends.
		wrapper.parentElement?.addEventListener("contextmenu", event => {
			opened.push({ x: event.clientX, y: event.clientY, prevented: event.defaultPrevented })
		})
		fireEvent.pointerDown(wrapper, { pointerType: "touch" })
		ask(true)
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetTouchMore }))

		// At the active cell's lower left (the handle's clientRect, as mocked), not taken for a long press's.
		expect(opened).toEqual([{ x: 110, y: 250, prevented: false }])
		expect(screen.queryByRole("toolbar")).toBeNull()
		expect(document.documentElement.hasAttribute("data-sheet-touch-menu")).toBe(true)

		act(() => {
			touch()?.onGridMenu(false)
		})

		expect(document.documentElement.hasAttribute("data-sheet-touch-menu")).toBe(false)
	})
})
