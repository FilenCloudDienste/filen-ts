// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, type ShapeSelection } from "@filen/office/react/presentation"
import "@/lib/i18n"
import { SlideCanvasContextMenu } from "@/features/presentation/components/contextMenu"
import { contextMenuPoint, isContextMenuKey } from "@/features/presentation/components/contextMenu.logic"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import {
	PresentationEditorContext,
	type PresentationEditor,
	type PresentationEditorScope
} from "@/features/presentation/hooks/usePresentationSession"

// The slide canvas's context menu: right click, Shift+F10 and the Menu key open it on the selection (the shape
// commands) or on the slide (the slide commands, on the slide in view); a body being edited, a deck that can only be
// viewed and the running show keep the browser's menu.

const EMU = 9525
const SLIDE = slideRef(1)

function slideRender(): SlideRender {
	const layer = (id: number, x: number) => ({
		shape: { slide: SLIDE, id },
		role: "shape",
		drawing: { width: 100, height: 100 },
		matrix: [1, 0, 0, 1, x, 100],
		box: { id, xfrm: { x: x * EMU, y: 100 * EMU, cx: 100 * EMU, cy: 100 * EMU, rot: 0, flipH: false, flipV: false } }
	})

	return {
		ref: SLIDE,
		index: 0,
		revision: 1,
		hidden: false,
		background: {},
		layers: [layer(2, 100), layer(3, 400)],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

interface Harness {
	readonly selection: ShapeSelection
	readonly commands: DeckOp[]
	readonly runs: unknown[]
	readonly edits: unknown[]
	readonly add: ReturnType<typeof vi.fn>
}

function mount({ editable = true, disabled = false }: { editable?: boolean; disabled?: boolean } = {}): Harness {
	const selection = createShapeSelection()
	const commands: DeckOp[] = []
	const runs: unknown[] = []
	const edits: unknown[] = []
	const add = vi.fn()
	const ribbon = {
		info: { size: { cx: 960 * EMU, cy: 540 * EMU }, editable: true },
		render: slideRender(),
		selection,
		command: (op: DeckOp) => {
			commands.push(op)

			return Promise.resolve({ ok: true, revision: 1, dirty: true } as CommandResult)
		},
		session: {},
		text: createTextEditing()
	} as unknown as PresentationRibbonEditor
	const editor = {
		editable,
		current: 0,
		currentRef: SLIDE,
		document: { slides: [{ ref: SLIDE }, { ref: slideRef(2) }] },
		selection: [SLIDE, slideRef(2)],
		layouts: [{ ref: 900, master: 800, number: 1, name: "Title Slide" }],
		currentLayout: 900,
		slides: { add },
		run: (ops: unknown) => {
			runs.push(ops)

			return Promise.resolve(true)
		},
		go: vi.fn()
	} as unknown as PresentationEditor
	const scope = { editor, view: {} } as unknown as PresentationEditorScope

	selection.show(SLIDE)
	render(
		<PresentationEditorContext value={scope}>
			<SlideCanvasContextMenu
				editor={ribbon}
				disabled={disabled}
				onEditText={shape => {
					edits.push(shape)
				}}
			>
				<div data-testid="canvas">
					<div
						className="fo-slide-frame"
						data-testid="frame"
					>
						<div
							data-fo-shape-edit=""
							data-testid="layer"
							tabIndex={0}
						/>
						<div data-fo-text-editor="">
							<div
								contentEditable
								data-testid="body"
							/>
						</div>
					</div>
				</div>
			</SlideCanvasContextMenu>
		</PresentationEditorContext>
	)

	return { selection, commands, runs, edits, add }
}

function rightClick(element: Element, x = 10, y = 10): MouseEvent {
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })

	act(() => {
		element.dispatchEvent(event)
	})

	return event
}

afterEach(() => {
	cleanup()
})

describe("the slide canvas context menu", () => {
	it("on a selected shape offers the shape commands and runs them on the selection", async () => {
		const harness = mount()

		act(() => {
			harness.selection.set([2])
		})
		const event = rightClick(screen.getByTestId("layer"))

		expect(event.defaultPrevented).toBe(true)
		expect(await screen.findByRole("menuitem", { name: "Edit text" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "New slide" })).toBeNull()

		fireEvent.click(screen.getByRole("menuitem", { name: "Bring to front" }))
		const front = await waitFor(() => {
			const items = screen.getAllByRole("menuitem", { name: "Bring to front" })

			const item = items[1]

			if (items.length !== 2 || item === undefined) throw new Error("the submenu is not open")

			return item
		})

		fireEvent.click(front)
		await waitFor(() => {
			expect(harness.commands).toEqual([{ family: "shape", kind: "zOrder", slide: SLIDE, shapes: [2], to: "front" }])
		})
	})

	it("Edit Text opens the shape's body", async () => {
		const harness = mount()

		act(() => {
			harness.selection.set([3])
		})
		rightClick(screen.getByTestId("layer"))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Edit text" }))
		expect(harness.edits).toEqual([{ slide: SLIDE, id: 3 }])
	})

	it("beside the slide clears the shape selection and offers the slide commands on the slide in view only", async () => {
		const harness = mount()

		act(() => {
			harness.selection.set([2])
		})
		rightClick(screen.getByTestId("canvas"))
		expect(harness.selection.getSnapshot().ids).toEqual([])
		fireEvent.click(await screen.findByRole("menuitem", { name: "Reset slide" }))
		// The rail holds two slides; the canvas's Reset is the slide in view's.
		expect(harness.runs).toEqual([[{ family: "slide", kind: "reset", slide: SLIDE }]])
	})

	it("opens with Shift+F10 and the Menu key, at the selection, keeping the selection", async () => {
		const harness = mount()

		act(() => {
			harness.selection.set([3])
		})
		const layer = screen.getByTestId("layer")
		const key = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })

		act(() => {
			layer.dispatchEvent(key)
		})
		expect(key.defaultPrevented).toBe(true)
		expect(await screen.findByRole("menuitem", { name: "Edit text" })).toBeTruthy()
		expect(harness.selection.getSnapshot().ids).toEqual([3])

		// The browser's own menu event for the key (Windows sends one at the focused element) is the same menu.
		const echo = rightClick(layer)

		expect(echo.defaultPrevented).toBe(true)
		expect(harness.selection.getSnapshot().ids).toEqual([3])
	})

	it("keeps the browser's menu in a body being edited, in a deck that can only be viewed and while the show runs", () => {
		mount()
		expect(rightClick(screen.getByTestId("body")).defaultPrevented).toBe(false)

		const body = screen.getByTestId("body")
		const key = new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })

		body.dispatchEvent(key)
		expect(key.defaultPrevented).toBe(false)
		cleanup()

		mount({ editable: false })
		expect(rightClick(screen.getByTestId("layer")).defaultPrevented).toBe(false)
		cleanup()

		mount({ disabled: true })
		expect(rightClick(screen.getByTestId("layer")).defaultPrevented).toBe(false)
		expect(screen.queryByRole("menu")).toBeNull()
	})
})

describe("the slide canvas menu's keys and anchor", () => {
	it("takes Shift+F10 and the Menu key, nothing else", () => {
		const key = (key: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
			isContextMenuKey({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods })

		expect(key("F10", { shiftKey: true })).toBe(true)
		expect(key("ContextMenu")).toBe(true)
		expect(key("F10")).toBe(false)
		expect(key("F10", { shiftKey: true, ctrlKey: true })).toBe(false)
		expect(key("ContextMenu", { shiftKey: true })).toBe(false)
	})

	it("opens at the centre of the selection's bounds in the slide's frame, else at the slide's centre", () => {
		const frame = { left: 100, top: 50, width: 480, height: 270 }
		const size = { cx: 960, cy: 540 }

		expect(contextMenuPoint(frame, size, [])).toEqual({ x: 340, y: 185 })
		expect(
			contextMenuPoint(frame, size, [
				{ x: 0, y: 0, r: 100, b: 100 },
				{ x: 300, y: 200, r: 500, b: 300 }
			])
		).toEqual({ x: 100 + 125, y: 50 + 75 })
		// A selection hanging off the slide opens at its edge.
		expect(contextMenuPoint(frame, size, [{ x: 2000, y: -500, r: 2100, b: -400 }])).toEqual({ x: 580, y: 50 })
	})
})
