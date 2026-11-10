// @vitest-environment happy-dom
import "@/tests/support/officeKeys"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DocxEditorSnapshot } from "@filen/office/core/docx/edit"
import { DocxMiniToolbar, type DocxMiniToolbarRequest } from "@/features/preview/components/docxMiniToolbar"
import { MINI_TOOLBAR_FADED } from "@/features/preview/components/docxMiniToolbar.logic"
import { FONTS, ribbonSnapshot } from "@/tests/docxRibbonHarness"

// Word's Mini toolbar: its two rows of commands in Word's order, labelled for assistive technology; faded as a mouse
// selection shows it, opaque as the pointer reaches it, hidden as the pointer moves away, on a key typed in the document
// or a press elsewhere; opaque and kept with the context menu.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

// happy-dom lays nothing out: the toolbar is a point, placed at (pointer x - 8, line top - 8).
const SELECTION: DocxMiniToolbarRequest = { kind: "selection", at: { x: 300, y: 400, below: 20 }, pointer: { x: 300, y: 410 } }

function renderMini(request: DocxMiniToolbarRequest = SELECTION, snapshot: DocxEditorSnapshot = ribbonSnapshot(), readOnly = false) {
	const execute = vi.fn()
	const onClose = vi.fn()
	const container = document.createElement("div")
	const document_ = document.createElement("div")

	document.body.append(container, document_)

	const result = render(
		<DocxMiniToolbar
			request={request}
			container={container}
			bounds={createRef()}
			elementRef={createRef()}
			menu={() => null}
			scroller={() => null}
			snapshot={snapshot}
			readOnly={readOnly}
			execute={execute}
			fonts={FONTS}
			styles={["normal", "heading1"]}
			theme={[]}
			onClose={onClose}
		/>,
		{ container }
	)
	const toolbar = screen.getByRole("toolbar", { name: "Mini toolbar" })

	return { ...result, execute, onClose, toolbar, outside: document_ }
}

function move(x: number, y: number): void {
	fireEvent.pointerMove(window, { pointerType: "mouse", clientX: x, clientY: y })
}

describe("DocxMiniToolbar", () => {
	it("offers Word's items in two rows, in Word's order", () => {
		const { toolbar } = renderMini()
		const names = (row: Element): string[] =>
			Array.from(
				row.querySelectorAll("button[aria-label], input[aria-label]"),
				element => element.getAttribute("aria-label") ?? ""
			).filter((name, index, all) => all.indexOf(name) === index)
		const [first, second] = Array.from(toolbar.children)

		if (first === undefined || second === undefined) {
			throw new Error("two rows expected")
		}

		expect(names(first)).toEqual(["Font", "Font size", "Increase font size", "Decrease font size", "Paragraph style"])
		expect(names(second)).toEqual([
			"Bold",
			"Italic",
			"Underline",
			"Highlight color",
			"Font color",
			"Bulleted list",
			"Numbered list",
			"Decrease indent",
			"Increase indent"
		])
	})

	it("runs the editor's commands and shows the selection's formatting", () => {
		const snapshot = ribbonSnapshot({
			formats: { bold: "on", italic: "off", underline: "off", strike: "off" },
			paragraph: { style: "normal", styleName: null, align: "start", list: "bullet", level: 0 }
		})
		const { execute } = renderMini(SELECTION, snapshot)

		expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true")
		expect(screen.getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("false")
		expect(screen.getByRole("button", { name: "Bulleted list" }).getAttribute("aria-pressed")).toBe("true")
		expect(screen.getByRole("button", { name: "Increase indent" }).getAttribute("aria-pressed")).toBeNull()

		for (const [name, type] of [
			["Italic", "format.italic"],
			["Increase font size", "font.grow"],
			["Numbered list", "list.numbered"],
			["Decrease indent", "list.outdent"]
		] as const) {
			fireEvent.click(screen.getByRole("button", { name }))
			expect(execute).toHaveBeenLastCalledWith({ type })
		}
	})

	it("offers nothing to run while the document cannot change", () => {
		renderMini(SELECTION, ribbonSnapshot(), true)

		expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Increase indent" }).hasAttribute("disabled")).toBe(true)
	})

	it("appears faded, turns opaque as the pointer reaches it and hides as it moves away", () => {
		const { toolbar, onClose } = renderMini()

		expect(toolbar.style.opacity).toBe(String(MINI_TOOLBAR_FADED))
		// Its top left: (292, 392).
		move(292, 392)
		expect(toolbar.style.opacity).toBe("1")
		move(292, 392 + 30)
		expect(Number(toolbar.style.opacity)).toBeLessThan(MINI_TOOLBAR_FADED)
		expect(onClose).not.toHaveBeenCalled()
		move(292, 392 + 200)
		expect(onClose).toHaveBeenCalledWith(false)
	})

	it("stays opaque on the pointer over it, and ignores touch", () => {
		const { toolbar, onClose } = renderMini()

		fireEvent.pointerMove(toolbar, { pointerType: "mouse", clientX: 900, clientY: 900 })
		expect(toolbar.style.opacity).toBe("1")
		fireEvent.pointerMove(window, { pointerType: "touch", clientX: 900, clientY: 900 })
		expect(onClose).not.toHaveBeenCalled()
	})

	it("hides on a key typed in the document, not on a modifier", () => {
		const { onClose, outside } = renderMini()

		fireEvent.keyDown(outside, { key: "Shift" })
		expect(onClose).not.toHaveBeenCalled()
		fireEvent.keyDown(outside, { key: "a" })
		expect(onClose).toHaveBeenCalledWith(false)
	})

	it("takes Escape in the document for itself", () => {
		const { onClose, outside } = renderMini()
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
		const reached = vi.fn()

		outside.addEventListener("keydown", reached)
		outside.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		expect(reached).not.toHaveBeenCalled()
		expect(onClose).toHaveBeenCalledWith(false)
	})

	it("gives the document the focus on Escape in it", () => {
		const { onClose } = renderMini()
		const bold = screen.getByRole("button", { name: "Bold" })

		bold.focus()
		fireEvent.keyDown(bold, { key: "Escape" })
		expect(onClose).toHaveBeenCalledWith(true)
	})

	it("hides on a press elsewhere, not on one on it", () => {
		vi.useFakeTimers()

		const { onClose, toolbar, outside } = renderMini()

		fireEvent.pointerDown(toolbar, { pointerType: "mouse" })
		act(() => {
			vi.runAllTimers()
		})
		expect(onClose).not.toHaveBeenCalled()
		fireEvent.pointerDown(outside, { pointerType: "mouse" })
		act(() => {
			vi.runAllTimers()
		})
		expect(onClose).toHaveBeenCalledWith(false)
	})

	it("is opaque with the context menu and left to it", () => {
		vi.useFakeTimers()

		const { toolbar, onClose, outside } = renderMini({ kind: "menu", at: { x: 300, y: 400, below: 0 }, pointer: { x: 300, y: 400 } })

		expect(toolbar.style.opacity).toBe("1")
		move(900, 900)
		fireEvent.keyDown(outside, { key: "ArrowDown" })
		fireEvent.pointerDown(outside, { pointerType: "mouse" })
		act(() => {
			vi.runAllTimers()
		})
		expect(onClose).not.toHaveBeenCalled()
	})

	it("hides as the document scrolls", () => {
		const scroller = document.createElement("div")
		const onClose = vi.fn()
		const container = document.createElement("div")

		document.body.append(container)
		render(
			<DocxMiniToolbar
				request={SELECTION}
				container={container}
				bounds={createRef()}
				elementRef={createRef()}
				menu={() => null}
				scroller={() => scroller}
				snapshot={ribbonSnapshot()}
				readOnly={false}
				execute={vi.fn()}
				fonts={FONTS}
				styles={["normal"]}
				theme={[]}
				onClose={onClose}
			/>,
			{ container }
		)
		fireEvent.scroll(scroller)
		expect(onClose).toHaveBeenCalledWith(false)
	})
})
