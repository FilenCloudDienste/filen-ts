// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { gridView, type SheetGridHandle, type SheetGridModel, type SheetGridState } from "@filen/office/react/sheet"
import type { SheetDrawingObject } from "@filen/office/react/sheet/drawings"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { requestImage } from "@/features/spreadsheet/objects/insertRequests"
import { objectLabel, objectsEditable, pictureRefusalKey } from "@/features/spreadsheet/objects/objects.logic"
import { selectObject, selectedObjectKey } from "@/features/spreadsheet/objects/objectSelection"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"

// Pictures in the sheet view: drawn over the grid with their names, selected by a press, deleted by Delete (and the
// selection given back to the cells), a press on a cell deselecting them, and the toolbar's request for a picture from
// the drive opening the drive's picker.

vi.mock("@/features/drive/components/driveFilePickerDialog", () => ({
	DriveFilePickerDialog: ({ title }: { title: string }) => <div role="dialog">{title}</div>
}))

const { useSheetObjects } = await import("@/features/spreadsheet/objects/useSheetObjects")

// A 1×1 PNG.
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
	character => character.charCodeAt(0)
)

beforeAll(() => {
	URL.createObjectURL = () => "blob:picture"
	URL.revokeObjectURL = () => undefined
	Element.prototype.setPointerCapture = () => undefined
})

afterEach(() => {
	cleanup()
})

// An object's element by its accessible name (placed off screen here: the test grid draws no frame).
async function findObject(name: string): Promise<HTMLElement> {
	return waitFor(() => {
		const found = document.querySelector<HTMLElement>(`[role="img"][aria-label="${name}"]`)

		if (found === null) throw new Error(`no object ${name}`)

		return found
	})
}

// A grid handle; with `model`, an 800 by 600 px view of its sheet at the top left, drawn whenever the model repaints.
// Its frames: schedule draws one on the next animation frame, which calls the frame listeners.
function gridHandle(focus: () => void, model?: SheetGridModel): SheetGridHandle {
	const currentView = () => {
		const axes = model?.axes(0) ?? null
		const layout = model?.layout(0) ?? null

		return axes === null || layout === null ? null : gridView(axes, layout, { top: 0, left: 0 }, 800, 600)
	}
	const frames = new Set<() => void>()
	let frame = 0
	const schedule = () => {
		if (frame !== 0) return

		frame = requestAnimationFrame(() => {
			frame = 0

			for (const listener of frames) listener()
		})
	}

	return {
		renderer: { currentView, schedule, scrollBy: () => undefined },
		onFrame: (listener: () => void) => {
			const unpaint = model?.onPaint(listener)

			frames.add(listener)

			return () => {
				frames.delete(listener)
				unpaint?.()
			}
		},
		reveal: vi.fn(),
		focus
	} as unknown as SheetGridHandle
}

function Objects({
	grid,
	handle,
	onExtension
}: {
	grid: SheetGridState
	handle: SheetGridHandle
	onExtension: (extension: SheetBodyExtension) => void
}) {
	const extension = useSheetObjects({
		grid,
		gridRef: { current: handle },
		handle: { session: grid.model.session } as unknown as SheetHandle,
		canEdit: true,
		text: false
	})

	useEffect(() => {
		onExtension(extension)
	})

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger
					render={
						<div
							data-testid="grid"
							className="fo-sheet"
						>
							{extension.overlay}
						</div>
					}
				/>
				<ContextMenuContent>{extension.menuItems}</ContextMenuContent>
			</ContextMenu>
			<button type="button">After the grid</button>
			{extension.dialogs}
		</>
	)
}

async function mount(
	options: { viewed?: boolean; pictures?: readonly { readonly row: number; readonly alt: string }[] } = {}
): Promise<{ model: SheetGridModel; extension: () => SheetBodyExtension; focus: ReturnType<typeof vi.fn> }> {
	const model = await openGrid(await workbook([{ name: "One", rows: [["a"]] }]), "xlsx")

	for (const picture of options.pictures ?? [{ row: 1, alt: "Company logo" }]) {
		const inserted = await model.command({
			type: "drawing.insertImage",
			sheet: 0,
			placement: { from: { row: picture.row, col: 1, rowOff: 0, colOff: 0 } },
			bytes: PNG,
			name: "",
			alt: picture.alt
		})

		expect(inserted.ok).toBe(true)
	}

	const focus = vi.fn()
	const handle = gridHandle(focus, options.viewed === true ? model : undefined)
	let latest: SheetBodyExtension | null = null

	render(
		<GridHarness model={model}>
			{grid => (
				<Objects
					grid={grid}
					handle={handle}
					onExtension={extension => {
						latest = extension
					}}
				/>
			)}
		</GridHarness>
	)

	return {
		model,
		focus,
		extension: () => {
			if (latest === null) throw new Error("not rendered")

			return latest
		}
	}
}

describe("sheet objects view", () => {
	it("draws an inserted picture as an image named by its alt text, selects it on a press and deletes it with Delete", async () => {
		const { model, focus } = await mount()
		const picture = await findObject("Company logo")

		fireEvent.pointerDown(picture, { button: 0, pointerId: 1, pointerType: "mouse" })
		expect(selectedObjectKey(model)).toEqual({ sheet: 0, key: 0 })

		fireEvent.keyDown(picture, { key: "Delete" })

		await waitFor(() => {
			expect(document.querySelector('[role="img"][aria-label="Company logo"]')).toBeNull()
		})
		expect(selectedObjectKey(model)).toBeNull()
		expect(focus).toHaveBeenCalled()
		expect(model.getSnapshot().layout?.extensions?.drawings).toBeUndefined()
	})

	it("gives the selection back to the cells on a press on a cell", async () => {
		const { model, extension } = await mount()

		await findObject("Company logo")
		act(() => {
			selectObject(model, { sheet: 0, key: 0 })
		})
		act(() => {
			extension().grid?.pointer?.({
				kind: "down",
				row: 0,
				col: 0,
				clientX: 0,
				clientY: 0,
				pointerType: "mouse",
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				altKey: false,
				editing: false
			})
		})
		expect(selectedObjectKey(model)).toBeNull()
	})

	it("selects an object on a tap on a touch screen, where objects let the finger through to the grid", async () => {
		const { model, extension } = await mount()
		const picture = await findObject("Company logo")
		const pane = picture.parentElement

		if (pane === null) throw new Error("no pane")

		pane.style.visibility = "visible"

		const rect = { left: 100, top: 100, right: 200, bottom: 150, x: 100, y: 100, width: 100, height: 50, toJSON: () => ({}) }

		picture.getBoundingClientRect = () => rect
		pane.getBoundingClientRect = () => ({ ...rect, left: 0, top: 0, right: 1000, bottom: 700 })

		const tap = (clientX: number, clientY: number): unknown =>
			extension().grid?.pointer?.({
				kind: "down",
				row: 3,
				col: 2,
				clientX,
				clientY,
				pointerType: "touch",
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				altKey: false,
				editing: false
			})

		let taken: unknown

		act(() => {
			taken = tap(150, 120)
		})
		expect(taken).toBe(true)
		expect(selectedObjectKey(model)).toEqual({ sheet: 0, key: 0 })
		act(() => {
			taken = tap(400, 400)
		})
		expect(taken).toBeUndefined()
		expect(selectedObjectKey(model)).toBeNull()
	})

	it("runs what the grid menu's items say when they are clicked", async () => {
		const { model } = await mount()
		const picture = await findObject("Company logo")
		const menu = async (name: string): Promise<void> => {
			fireEvent.contextMenu(screen.getByTestId("grid"))
			fireEvent.click(await screen.findByRole("menuitem", { name }))
		}

		fireEvent.pointerDown(picture, { button: 0, pointerId: 1, pointerType: "mouse" })
		await menu("Edit alt text…")
		expect((await screen.findByRole("dialog")).textContent).toContain("Alt text")
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Description" }), { key: "Escape" })

		const chooser = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)

		fireEvent.contextMenu(screen.getByTestId("grid"))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Insert image" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Image from file…" }))
		expect(chooser).toHaveBeenCalled()
		chooser.mockRestore()

		await menu("Delete object")
		await waitFor(() => {
			expect(model.getSnapshot().layout?.extensions?.drawings).toBeUndefined()
		})
	})

	it("puts an object a refused move left back where it is", async () => {
		const { model } = await mount({ viewed: true })
		const picture = await findObject("Company logo")
		const before = picture.style.transform
		const refused = vi.spyOn(model, "command").mockResolvedValueOnce({
			ok: false,
			refusal: { reason: "protectedSheet", detail: "objects" },
			state: model.getSnapshot().state
		})

		fireEvent.pointerDown(picture, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 })
		fireEvent.pointerMove(picture, { pointerId: 1, clientX: 110, clientY: 60 })
		await waitFor(() => {
			expect(picture.style.transform).not.toBe(before)
		})
		fireEvent.pointerUp(picture, { pointerId: 1, clientX: 110, clientY: 60 })

		await waitFor(() => {
			expect(refused).toHaveBeenCalledWith(expect.objectContaining({ type: "drawing.move" }))
			expect(picture.style.transform).toBe(before)
		})
	})

	it("draws only the objects on screen or near it", async () => {
		await mount({
			viewed: true,
			pictures: [
				{ row: 1, alt: "Near" },
				{ row: 4000, alt: "Far" }
			]
		})

		const near = await findObject("Near")
		const far = await findObject("Far")

		await waitFor(() => {
			expect(near.childElementCount).toBeGreaterThan(0)
		})
		expect(far.childElementCount).toBe(0)
	})

	it("selects the first object on screen with Ctrl+Alt+5, and the sheet's first, scrolled to, when none is", async () => {
		const { model, extension } = await mount({
			viewed: true,
			pictures: [
				{ row: 4000, alt: "Far" },
				{ row: 1, alt: "Near" }
			]
		})
		const near = await findObject("Near")

		act(() => {
			expect(extension().shortcut?.("selectObject")).toBe(true)
		})
		expect(selectedObjectKey(model)).toEqual({ sheet: 0, key: 1 })
		await waitFor(() => {
			expect(document.activeElement).toBe(near)
		})
		expect(extension().shortcut?.("find")).toBe(false)
	})

	it("takes focus when an object is selected, never back from what follows the grid when the sheet changes", async () => {
		const { model } = await mount()
		const picture = await findObject("Company logo")
		const after = screen.getByRole("button", { name: "After the grid" })

		act(() => {
			selectObject(model, { sheet: 0, key: 0 })
		})
		await waitFor(() => {
			expect(document.activeElement).toBe(picture)
		})

		after.focus()

		const object = model.getSnapshot().layout?.extensions?.drawings?.objects[0]

		if (object === undefined) throw new Error("no object")

		const changed = await act(() => model.command({ type: "drawing.alt", sheet: 0, key: object.key, stamp: object.stamp, alt: "Logo" }))

		expect(changed.ok).toBe(true)
		await findObject("Logo")
		expect(document.activeElement).toBe(after)
	})

	it("opens a picture's alternative text with Enter or F2, and its menu with Shift+F10", async () => {
		const { model } = await mount()
		const picture = await findObject("Company logo")

		act(() => {
			selectObject(model, { sheet: 0, key: 0 })
		})
		fireEvent.keyDown(picture, { key: "Enter" })
		expect((await screen.findByRole("dialog")).textContent).toContain("Alt text")
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Description" }), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		fireEvent.keyDown(picture, { key: "F2" })
		expect((await screen.findByRole("dialog")).textContent).toContain("Alt text")
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Description" }), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})

		fireEvent.keyDown(picture, { key: "F10", shiftKey: true })
		expect(await screen.findByRole("menuitem", { name: "Edit alt text…" })).toBeDefined()
	})

	it("moves on from the last object with Tab, and back to the cells with Shift+Tab", async () => {
		const { model, focus } = await mount()
		const picture = await findObject("Company logo")
		const after = screen.getByRole("button", { name: "After the grid" })

		after.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList
		act(() => {
			selectObject(model, { sheet: 0, key: 0 })
		})
		await waitFor(() => {
			expect(document.activeElement).toBe(picture)
		})
		expect(picture.tabIndex).toBe(0)

		fireEvent.keyDown(picture, { key: "Tab" })
		expect(document.activeElement).toBe(after)
		// Still selected: what follows (the chart editor) acts on it.
		expect(selectedObjectKey(model)).toEqual({ sheet: 0, key: 0 })

		picture.focus()
		fireEvent.keyDown(picture, { key: "Tab", shiftKey: true })
		expect(selectedObjectKey(model)).toBeNull()
		expect(focus).toHaveBeenCalled()
	})

	it("opens the drive's picker when the toolbar asks for a picture from the drive", async () => {
		const { model } = await mount()

		act(() => {
			requestImage(model, "drive")
		})
		expect((await screen.findByRole("dialog")).textContent).toBe("Insert an image from your drive")
	})
})

describe("sheet objects logic", () => {
	const object = (alt: string, name: string, kind: SheetDrawingObject["kind"]): SheetDrawingObject => ({
		key: 0,
		stamp: "0:0:0",
		kind,
		name,
		alt,
		hidden: false,
		noMove: false,
		noResize: false,
		anchor: { mode: "absolute", x: 0, y: 0, cx: 1, cy: 1 }
	})

	it("locks objects on a sheet whose protection does not allow editing them", () => {
		expect(objectsEditable(null)).toBe(true)
		expect(objectsEditable({ protection: null } as never)).toBe(true)
		expect(objectsEditable({ protection: { hasPassword: false, allows: new Set(["objects"]) } } as never)).toBe(true)
		expect(objectsEditable({ protection: { hasPassword: false, allows: new Set(["sort"]) } } as never)).toBe(false)
	})

	it("names an object by its alt text, else its name, else what it is", () => {
		const t = (key: string): string => key

		expect(objectLabel(object("Logo", "Picture 1", "picture"), t)).toBe("Logo")
		expect(objectLabel(object(" ", "Picture 1", "picture"), t)).toBe("Picture 1")
		expect(objectLabel(object("", "", "chart"), t)).toBe("previewSheetObjectChart")
	})

	it("says what a refused picture is with the workbook's own words", () => {
		expect(pictureRefusalKey("format")).toBe("previewSheetObjectFormat")
		expect(pictureRefusalKey("full")).toBe("previewSheetObjectFailed")
	})
})
