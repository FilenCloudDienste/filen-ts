// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
	DOCX_EDITOR_COMMANDS,
	NO_REVIEW,
	NO_VALUES,
	type DocxDrawingContext,
	type DocxEditorSnapshot,
	type DocxFieldContext
} from "@filen/office/core/docx/edit"
import type { PagedEditor, PagedEditorEvent } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import { drawingItems, slotCommands } from "@/features/preview/components/docxEditor.logic"
import { drawingCrop, setDrawingCrop } from "@/features/preview/components/docxDrawingCrop"
import { DocxDrawingPress, DocxObjectHandles } from "@/features/preview/components/docxObjectHandles"
import { DocxDrawingMenu, DocxPictureCrop } from "@/features/preview/components/docxDrawingMenu"
import { DocxFieldChip } from "@/features/preview/components/docxFieldChip"
import "@/lib/i18n"

// Pictures on the pages: a press selects one and shows its frame and handles; a handle drags into one resize,
// crop mode into one crop; the Picture group's buttons (no cropping in Mobile view); and the chip at a field.

const EMU = 9525
const BOX = { x: 10, y: 20, width: 100, height: 50 }

function drawingAt(pos: number, extra: Partial<DocxDrawingContext> = {}): DocxDrawingContext {
	return {
		kind: "picture",
		anchored: false,
		wrap: "inline",
		cx: BOX.width * EMU,
		cy: BOX.height * EMU,
		x: null,
		y: null,
		relH: "column",
		relV: "paragraph",
		rotation: 0,
		flipH: false,
		flipV: false,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		altText: "",
		resizable: true,
		rotatable: true,
		placeable: true,
		croppable: true,
		lockAspect: false,
		pos,
		...extra
	}
}

function fakeEditor(): { editor: PagedEditor; select: ReturnType<typeof vi.fn> } {
	const listeners = new Set<(event: PagedEditorEvent) => void>()
	let selected: DocxDrawingContext | null = null
	const snapshot = {
		context: { drawing: null as DocxDrawingContext | null },
		enabled: Object.fromEntries(DOCX_EDITOR_COMMANDS.map(command => [command.type, true])) as DocxEditorSnapshot["enabled"]
	}

	const select = vi.fn((hit: { pos: number }) => {
		selected = drawingAt(hit.pos)
		snapshot.context = { drawing: selected }

		for (const listener of listeners) {
			listener({ type: "selection" })
		}

		return true
	})
	const editor = {
		activeStory: 0,
		body: { session: { story: { story: { index: 0 } } } },
		state: { doc: { nodeAt: () => ({ isTextblock: false, isInline: true }) } },
		subscribe: (listener: (event: PagedEditorEvent) => void) => {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		snapshot: () => snapshot,
		selection: () => ({
			from: selected?.pos ?? 1,
			to: selected?.pos ?? 1,
			anchor: 1,
			head: 1,
			empty: selected === null,
			node: selected !== null
		}),
		select,
		exitStory: vi.fn()
	} as unknown as PagedEditor

	return { editor, select }
}

function press(kind: "drawing" | "field" | "noteRef", extra: Partial<DocxObjectPress> = {}, part?: string): DocxObjectPress {
	return {
		hit: { kind, story: 0, pos: 5, box: BOX, ...(part === undefined ? {} : { part }) },
		page: 0,
		x: 50,
		y: 40,
		clientX: 50,
		clientY: 40,
		pointerType: "mouse",
		pointerId: 1,
		clicks: 1,
		shiftKey: false,
		...extra
	}
}

function found(root: ParentNode, selector: string): Element {
	const element = root.querySelector(selector)

	if (element === null) {
		throw new Error(`no ${selector}`)
	}

	return element
}

const PAGE = { index: 0, width: 816, height: 1056, zoom: 1 }

function pointer(type: string, clientX: number, clientY: number): void {
	window.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX, clientY, bubbles: true }))
}

function snapshot(
	drawing: DocxDrawingContext | null,
	enabled: Partial<DocxEditorSnapshot["enabled"]> = {},
	field: DocxFieldContext | null = null
): DocxEditorSnapshot {
	return {
		version: 1,
		readOnly: false,
		readOnlyReasons: [],
		dirty: false,
		canUndo: false,
		canRedo: false,
		selection: { empty: true, from: 1, to: 1, locked: null, paragraphs: 1 },
		formats: { bold: "off", italic: "off", underline: "off", strike: "off" },
		paragraph: { style: "normal", styleName: null, align: "start", list: "none", level: null },
		values: NO_VALUES,
		context: {
			story: { kind: "body", index: 0 },
			table: null,
			drawing,
			control: null,
			field,
			link: null,
			comment: null,
			equation: null
		},
		review: NO_REVIEW,
		enabled: {
			...(Object.fromEntries(DOCX_EDITOR_COMMANDS.map(command => [command.type, true])) as DocxEditorSnapshot["enabled"]),
			...enabled
		}
	}
}

afterEach(() => {
	cleanup()
})

describe("DocxObjectHandles", () => {
	it("selects the picture pressed and frames it with its handles", () => {
		const { editor, select } = fakeEditor()
		const { container } = render(
			<DocxObjectHandles
				page={PAGE}
				editor={editor}
				press={press("drawing")}
				readOnly={false}
				execute={vi.fn()}
			/>
		)

		expect(select).toHaveBeenCalledWith(expect.objectContaining({ pos: 5, atom: true }))
		expect(container.querySelectorAll("[data-fo-object-frame]").length).toBe(1)
		expect(container.querySelectorAll("[data-fo-handle]").length).toBe(8)
	})

	it("resizes the picture by a handle dragged, in one command", () => {
		const { editor } = fakeEditor()
		const execute = vi.fn()
		const { container } = render(
			<DocxObjectHandles
				page={PAGE}
				editor={editor}
				press={press("drawing")}
				readOnly={false}
				execute={execute}
			/>
		)
		const handle = found(container, "[data-fo-handle='se']")

		act(() => {
			fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 110, clientY: 70 })
			pointer("pointermove", 130, 80)
		})

		expect((found(container, "[data-fo-object-frame]") as HTMLElement).style.width).toBe("120px")

		act(() => {
			pointer("pointerup", 130, 80)
		})

		expect(execute).toHaveBeenCalledTimes(1)
		expect(execute).toHaveBeenCalledWith({ type: "drawing.resize", cx: 120 * EMU, cy: 60 * EMU })
	})

	it("crops a side in crop mode, and drags nothing while read-only", () => {
		const { editor } = fakeEditor()
		const execute = vi.fn()
		const view = render(
			<DocxObjectHandles
				page={PAGE}
				editor={editor}
				press={press("drawing")}
				readOnly={false}
				execute={execute}
			/>
		)

		// Another editor's crop mode is its own.
		act(() => {
			setDrawingCrop(vi.fn(), 5)
		})

		expect(view.container.querySelectorAll("[data-fo-crop-handle]").length).toBe(0)

		act(() => {
			setDrawingCrop(execute, 5)
		})

		expect(view.container.querySelectorAll("[data-fo-crop-handle]").length).toBe(8)
		expect(view.container.querySelector("[data-fo-crop-picture]")).not.toBeNull()

		act(() => {
			fireEvent.pointerDown(found(view.container, "[data-fo-crop-handle='e']"), {
				button: 0,
				pointerId: 1,
				clientX: 110,
				clientY: 45
			})
			pointer("pointermove", 100, 45)
			pointer("pointerup", 100, 45)
		})

		expect(execute).toHaveBeenCalledWith({ type: "drawing.crop", left: 0, top: 0, right: 10_000, bottom: 0 })
		cleanup()

		const readOnly = render(
			<DocxObjectHandles
				page={PAGE}
				editor={fakeEditor().editor}
				press={press("drawing")}
				readOnly
				execute={execute}
			/>
		)

		expect(readOnly.container.querySelectorAll("[data-fo-handle], [data-fo-crop-handle]").length).toBe(0)
	})

	it("selects a picture pressed in Mobile view, where the pages' handles are not", () => {
		const { editor, select } = fakeEditor()
		const onPressDone = vi.fn()

		render(
			<DocxDrawingPress
				editor={editor}
				snapshot={undefined}
				surface="reflow"
				container={null}
				zoom={1}
				readOnly={false}
				execute={vi.fn()}
				press={press("drawing", { page: -1 })}
				onPressDone={onPressDone}
				inputRequest={null}
				requestInput={vi.fn()}
				onInputDone={vi.fn()}
			/>
		)

		expect(select).toHaveBeenCalledWith(expect.objectContaining({ pos: 5, atom: true }))
		expect(onPressDone).toHaveBeenCalled()
	})
})

describe("DocxDrawingMenu and DocxPictureCrop", () => {
	function renderGroup(surface: "pages" | "reflow", readOnly = false) {
		const execute = vi.fn()
		const requestInput = vi.fn()

		render(
			<DocxDrawingMenu
				commands={slotCommands("picture")}
				items={drawingItems(slotCommands("picture"), surface)}
				snapshot={snapshot(drawingAt(5))}
				readOnly={readOnly}
				apple={false}
				execute={execute}
				surface={surface}
				inputRequest={null}
				requestInput={requestInput}
				onInputDone={vi.fn()}
			/>
		)

		return { execute, requestInput }
	}

	it("offers wrap, rotate, crop, alt text and delete for the selected picture", async () => {
		const { execute, requestInput } = renderGroup("pages")

		fireEvent.click(screen.getByRole("button", { name: "Crop" }))
		expect(drawingCrop(execute)).toBe(5)
		expect(drawingCrop(vi.fn())).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Crop" }))
		expect(drawingCrop(execute)).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Alt text…" }))
		expect(requestInput).toHaveBeenLastCalledWith("drawing.altText")
		fireEvent.click(screen.getByRole("button", { name: "Delete picture" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "drawing.delete" })
		fireEvent.click(screen.getByRole("button", { name: "Wrap text" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Square" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "drawing.wrap", mode: "square" })
		fireEvent.click(screen.getByRole("button", { name: "Rotate" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rotate left 90°" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "drawing.rotate", by: 270 })
	})

	it("leaves crop mode on Enter or Escape in the document only: never on one for the find field, a button or a dialog", () => {
		const execute = vi.fn()

		const props = {
			commands: slotCommands("picture"),
			snapshot: snapshot(drawingAt(5)),
			readOnly: false,
			apple: false,
			execute,
			surface: "pages" as const,
			inputRequest: null,
			requestInput: vi.fn(),
			onInputDone: vi.fn()
		}

		// The crop mode's keys are the ribbon's, whichever tab shows.
		render(
			<>
				<DocxPictureCrop {...props} />
				<DocxDrawingMenu
					{...props}
					items={drawingItems(props.commands, "pages")}
				/>
			</>
		)
		fireEvent.click(screen.getByRole("button", { name: "Crop" }))
		expect(drawingCrop(execute)).toBe(5)

		const press = (target: Element, key: string): KeyboardEvent => {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })

			act(() => {
				target.dispatchEvent(event)
			})

			return event
		}
		const dialog = document.createElement("div")
		const find = document.createElement("input")
		const editor = document.createElement("div")
		const sink = document.createElement("textarea")

		const inDialog = document.createElement("input")

		dialog.setAttribute("role", "dialog")
		dialog.append(inDialog)
		editor.className = "fo-docx-editor"
		editor.append(sink)
		document.body.append(dialog, find, editor)

		for (const target of [inDialog, find, screen.getByRole("button", { name: "Crop" }), document.body]) {
			expect(press(target, "Enter").defaultPrevented).toBe(false)
			expect(drawingCrop(execute)).toBe(5)
		}

		expect(press(sink, "Escape").defaultPrevented).toBe(true)
		expect(drawingCrop(execute)).toBeNull()
		dialog.remove()
		find.remove()
		editor.remove()
	})

	it("shows no crop in Mobile view", () => {
		renderGroup("reflow")

		expect(screen.queryByRole("button", { name: "Crop" })).toBeNull()
		expect(screen.getByRole("button", { name: "Delete picture" })).toBeTruthy()
	})
})

describe("DocxFieldChip", () => {
	const field: DocxFieldContext = { type: "PAGE", updatable: true, toc: false, instruction: " PAGE ", refusal: null }

	function renderChip(enabled: Partial<DocxEditorSnapshot["enabled"]>, kind: "field" | "noteRef" = "field", clicks = 1) {
		const { editor, select } = fakeEditor()
		const execute = vi.fn()
		const onPressDone = vi.fn()

		render(
			<DocxFieldChip
				editor={editor}
				snapshot={snapshot(null, enabled, field)}
				surface="pages"
				container={document.body as HTMLDivElement}
				zoom={1}
				readOnly={false}
				execute={execute}
				press={press(kind, { clicks })}
				onPressDone={onPressDone}
				inputRequest={null}
				requestInput={vi.fn()}
				onInputDone={vi.fn()}
			/>
		)

		return { select, execute, onPressDone }
	}

	it("goes to the note at once on a double click on a note mark", () => {
		const { execute, onPressDone } = renderChip({}, "noteRef", 2)

		expect(execute).toHaveBeenCalledWith({ type: "note.goto" })
		expect(onPressDone).toHaveBeenCalled()
	})

	it("goes to the note of a note reference pressed", () => {
		const { select, execute, onPressDone } = renderChip({}, "noteRef")

		expect(select).toHaveBeenCalledWith(expect.objectContaining({ pos: 5, atom: false }))
		fireEvent.click(screen.getByRole("button", { name: "Go to note" }))
		expect(execute).toHaveBeenCalledWith({ type: "note.goto" })
		expect(onPressDone).toHaveBeenCalled()
		cleanup()

		renderChip({ "note.goto": false }, "noteRef")
		expect(screen.queryByRole("button", { name: "Go to note" })).toBeNull()
	})

	it("puts the caret at the field and updates it", () => {
		const { select, execute, onPressDone } = renderChip({})

		expect(select).toHaveBeenCalledWith(expect.objectContaining({ pos: 5, atom: false }))
		fireEvent.click(screen.getByRole("button", { name: "Update field" }))
		expect(execute).toHaveBeenCalledWith({ type: "field.update" })
		expect(onPressDone).toHaveBeenCalled()
	})

	it("is not shown while updating is off (layout resting)", () => {
		renderChip({ "field.update": false })

		expect(screen.queryByRole("button", { name: "Update field" })).toBeNull()
	})
})
