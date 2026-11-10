// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { slideRef, type DeckOp, type ShapeClip } from "@filen/office/core/presentation"
import type { ClipRequest, ClipResult, CommandResult, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, type ShapeSelection } from "@filen/office/react/presentation"
import { i18n } from "@/lib/i18n"
import { SlideListContextMenu } from "@/features/presentation/components/contextMenu"
import { usePresentationClipboard, type PresentationClipboardCommands } from "@/features/presentation/hooks/usePresentationClipboard"
import {
	PresentationEditorContext,
	type PresentationEditor,
	type PresentationEditorScope
} from "@/features/presentation/hooks/usePresentationSession"
import { clipboardPayload, forgetClips, heldClip } from "@/features/presentation/lib/presentationClipboard"

// Ctrl/Cmd+X, C and V on the slide and in the slide list (the browser's clipboard events), and the menus' Cut, Copy
// and Paste: a copy holds the worker's clip, a cut deletes what it copied as a step of its own, a paste of the held clip
// pastes it as one op and selects what it made, and a body being typed in keeps its own clipboard.

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

const CLIP: ShapeClip = {
	kind: "shapes",
	format: "pptx",
	slide: SLIDE,
	shapes: [{ raw: new TextEncoder().encode("<p:sp/>") }],
	boxes: [{ x: 100 * EMU, y: 100 * EMU, cx: 100 * EMU, cy: 100 * EMU, rot: 0, flipH: false, flipV: false }],
	relationships: [],
	text: [["Hello"]]
}

interface Harness {
	readonly selection: ShapeSelection
	readonly commands: DeckOp[]
	readonly clips: ClipRequest[]
	readonly commandsApi: { current: PresentationClipboardCommands | undefined }
}

function mount(): Harness {
	const selection = createShapeSelection()
	const commands: DeckOp[] = []
	const clips: ClipRequest[] = []
	const commandsApi: Harness["commandsApi"] = { current: undefined }
	const session = {
		clip: (request: ClipRequest) => {
			clips.push(request)

			return Promise.resolve({ ok: true, clip: CLIP } as ClipResult)
		},
		clipParts: vi.fn(),
		image: vi.fn()
	}
	const editor = {
		editable: true,
		current: 0,
		currentRef: SLIDE,
		selection: [SLIDE],
		document: {
			session,
			info: { format: "pptx", size: { cx: 960 * EMU, cy: 540 * EMU }, editable: true },
			renders: new Map([[SLIDE, slideRender()]]),
			slides: [
				{ ref: SLIDE, hidden: false },
				{ ref: slideRef(2), hidden: false }
			]
		},
		command: (op: DeckOp) => {
			commands.push(op)

			return Promise.resolve({ ok: true, revision: 1, dirty: true } as CommandResult)
		},
		run: vi.fn(() => Promise.resolve(true))
	} as unknown as PresentationEditor

	function Editor() {
		const rootRef = useRef<HTMLDivElement | null>(null)

		commandsApi.current = usePresentationClipboard({
			editor,
			selection,
			slideEditor: undefined,
			rootRef,
			takePictures: () => undefined,
			t: i18n.getFixedT(null, "preview")
		})

		return (
			<div ref={rootRef}>
				<div
					data-fo-shape-edit=""
					data-testid="layer"
					tabIndex={0}
				/>
				<div data-fo-text-editor="">
					<div
						contentEditable
						data-testid="body"
						tabIndex={0}
					/>
				</div>
			</div>
		)
	}

	selection.show(SLIDE)
	selection.set([2])
	render(<Editor />)

	return { selection, commands, clips, commandsApi }
}

function clipboardEvent(type: "copy" | "cut" | "paste", data: { html?: string; text?: string } = {}): Event {
	const event = new Event(type, { bubbles: true, cancelable: true })

	Object.defineProperty(event, "clipboardData", {
		value: {
			getData: (format: string) => (format === "text/html" ? (data.html ?? "") : format === "text/plain" ? (data.text ?? "") : ""),
			setData: () => undefined,
			files: []
		}
	})

	act(() => {
		document.activeElement?.dispatchEvent(event)
	})

	return event
}

afterEach(() => {
	cleanup()
	forgetClips()
})

describe("the presentation clipboard's keys", () => {
	it("copies the selected objects on Ctrl/Cmd+C and pastes them back on Ctrl/Cmd+V, one step down and right", async () => {
		const h = mount()

		screen.getByTestId("layer").focus()

		expect(clipboardEvent("copy").defaultPrevented).toBe(true)
		await waitFor(() => {
			expect(heldClip()?.clip).toBe(CLIP)
		})
		expect(h.clips).toEqual([{ kind: "shapes", slide: SLIDE, shapes: [2] }])

		const held = heldClip()

		if (held === undefined) throw new Error("no clip")

		expect(clipboardEvent("paste", clipboardPayload(held)).defaultPrevented).toBe(true)
		await waitFor(() => {
			expect(h.commands).toHaveLength(1)
		})
		expect(h.commands[0]).toMatchObject({ family: "shape", kind: "paste", slide: SLIDE, dx: 10 * EMU, dy: 10 * EMU })
	})

	it("cuts as the copy, then the delete of what it copied", async () => {
		const h = mount()

		screen.getByTestId("layer").focus()
		clipboardEvent("cut")
		await waitFor(() => {
			expect(h.commands).toEqual([{ family: "shape", kind: "delete", slide: SLIDE, shapes: [2] }])
		})
		expect(h.selection.getSnapshot().ids).toEqual([])
	})

	it("leaves a body being typed in its own clipboard", () => {
		const h = mount()

		screen.getByTestId("body").focus()

		expect(clipboardEvent("copy").defaultPrevented).toBe(false)
		expect(clipboardEvent("paste", { text: "typed" }).defaultPrevented).toBe(false)
		expect(h.clips).toEqual([])
	})

	it("does nothing on the slide with nothing selected", () => {
		const h = mount()

		act(() => {
			h.selection.clear()
		})
		screen.getByTestId("layer").focus()

		expect(clipboardEvent("copy").defaultPrevented).toBe(false)
		expect(h.clips).toEqual([])
	})
})

describe("the slide list menu's clipboard", () => {
	it("offers Cut, Copy and Paste first, on the selected slides", () => {
		const clipboard = { copy: vi.fn(), paste: vi.fn(), scope: vi.fn() }
		const editor = {
			editable: true,
			current: 0,
			currentRef: SLIDE,
			selection: [SLIDE],
			selectedIndices: new Set([0]),
			document: { slides: [{ ref: SLIDE, hidden: false }], info: { format: "pptx" } },
			layouts: [],
			slides: { add: vi.fn(), duplicate: vi.fn(), remove: vi.fn() },
			go: vi.fn()
		} as unknown as PresentationEditor
		const scope = { editor, view: {}, clipboard } as unknown as PresentationEditorScope

		render(
			<PresentationEditorContext value={scope}>
				<SlideListContextMenu>
					<div data-testid="rail" />
				</SlideListContextMenu>
			</PresentationEditorContext>
		)
		fireEvent.contextMenu(screen.getByTestId("rail"))

		const items = screen.getAllByRole("menuitem").map(item => item.textContent)

		expect(items.slice(0, 3).map(item => item.replace(/[⌘^⌥⇧]|Ctrl|\+|[A-Z]$/gu, "").trim())).toEqual(["Cut", "Copy", "Paste"])

		fireEvent.click(screen.getByRole("menuitem", { name: /Cut/u }))
		expect(clipboard.copy).toHaveBeenCalledWith(true, "slides")
	})
})
