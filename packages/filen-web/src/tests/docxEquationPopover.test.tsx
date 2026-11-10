// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useCallback, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, docxSchema, openDocxEditContext, selectEquation } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import type { DocxInputRequest } from "@/features/preview/components/docxEditor.logic"
import { DocxEquationPopover } from "@/features/preview/components/docxEquationPopover"
import "@/lib/i18n"

// Equations as LaTeX in the popover, on a real editing session: a new one with its live preview, errors and
// placement; one pressed on the pages edited (with changes tracked too), unchanged LaTeX leaving it be, a lossy
// one warned about; Esc; and the LaTeX of an equation that cannot change, shown read-only.

const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))
// An n-ary operator that grows with its operand: the subset cannot say that.
const LOSSY = '<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/><m:grow m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e/></m:nary></m:oMath>'

async function session(): Promise<DocxEditorSession> {
	const opened = await openDocxPackage(bytesSource(BYTES))

	if (!opened.ok) {
		throw new Error(opened.reason)
	}

	return new DocxEditorSession(await openDocxEditContext(opened.package, await buildDocxModel(opened.package)))
}

// The position of the first equation of the session's document.
function equationAt(editing: DocxEditorSession): number {
	let found = -1

	editing.state.doc.descendants((node, pos) => {
		if (found < 0 && node.type === docxSchema.nodes.math) {
			found = pos
		}
	})

	return found
}

function pressOn(pos: number): DocxObjectPress {
	return {
		hit: { kind: "equation", story: 0, pos },
		page: 0,
		x: 10,
		y: 10,
		clientX: 40,
		clientY: 60,
		pointerType: "mouse",
		pointerId: 1,
		clicks: 1,
		shiftKey: false
	}
}

function renderPopover(
	editing: DocxEditorSession,
	options: { press?: DocxObjectPress; request?: "equation.insert" | "equation.edit"; readOnly?: boolean } = {}
) {
	const execute = vi.fn()
	const onPressDone = vi.fn()
	const onInputDone = vi.fn()
	const editor = { session: editing, ends: () => ({ start: undefined, end: undefined }) } as unknown as PagedEditor
	const container = document.createElement("div")

	document.body.append(container)

	let pressOn: (press: DocxObjectPress) => void = () => undefined

	// The editor's side: the request stays open until the popover is done with it, a press until it is taken.
	function Host() {
		const [request, setRequest] = useState<DocxInputRequest | null>(
			options.request === undefined ? null : { type: options.request, nonce: 7 }
		)
		const [press, setPress] = useState<DocxObjectPress | null>(options.press ?? null)

		pressOn = setPress

		// Stable, as the editor's are.
		const pressDone = useCallback(() => {
			onPressDone()
			setPress(null)
		}, [])
		const inputDone = useCallback((nonce: number) => {
			onInputDone(nonce)
			setRequest(previous => (previous?.nonce === nonce ? null : previous))
		}, [])

		return (
			<DocxEquationPopover
				editor={editor}
				snapshot={editing.snapshot()}
				surface="pages"
				container={container}
				zoom={1}
				readOnly={options.readOnly ?? false}
				execute={execute}
				press={press}
				onPressDone={pressDone}
				inputRequest={request}
				requestInput={vi.fn()}
				onInputDone={inputDone}
			/>
		)
	}

	const result = render(<Host />)

	return {
		execute,
		onPressDone,
		onInputDone,
		result,
		press: (press: DocxObjectPress) => {
			act(() => {
				pressOn(press)
			})
		}
	}
}

function field(): HTMLTextAreaElement {
	return screen.getByLabelText("LaTeX")
}

afterEach(() => {
	cleanup()
	document.body.replaceChildren()
})

describe("DocxEquationPopover", () => {
	it("inserts a new equation from LaTeX, previewed as it is typed, inline or on its own line", async () => {
		const editing = await session()
		const { execute, onInputDone } = renderPopover(editing, { request: "equation.insert" })

		expect(screen.getByRole("dialog", { name: "Insert equation" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Insert" })).toHaveProperty("disabled", true)

		fireEvent.change(field(), { target: { value: "\\frac{a}{b}" } })
		await waitFor(() => {
			expect(screen.getByRole("img", { name: "Preview" }).querySelector("math mfrac")).not.toBeNull()
		})
		fireEvent.click(screen.getByRole("switch", { name: "On its own line" }))
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))

		expect(execute).toHaveBeenCalledWith({ type: "equation.insert", latex: "\\frac{a}{b}", display: true })
		expect(screen.queryByRole("dialog")).toBeNull()
		// The request is held while the popover is open, done as it closes.
		expect(onInputDone).toHaveBeenCalledTimes(1)
		expect(onInputDone).toHaveBeenCalledWith(7)
	})

	it("takes Insert and Edit equation as the shared input form: done when closed, at once when it cannot be taken", async () => {
		const editing = await session()
		const asked = renderPopover(editing, { request: "equation.insert" })

		fireEvent.change(field(), { target: { value: "x" } })
		expect(asked.onInputDone).not.toHaveBeenCalled()
		fireEvent.keyDown(field(), { key: "Escape" })
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(asked.onInputDone).toHaveBeenCalledWith(7)

		cleanup()

		// Edit equation with no equation selected: nothing to open.
		const nothing = renderPopover(editing, { request: "equation.edit" })

		await waitFor(() => {
			expect(nothing.onInputDone).toHaveBeenCalledWith(7)
		})
		expect(screen.queryByRole("dialog")).toBeNull()

		cleanup()

		// An equation pressed while Insert equation is open takes the popover; the request is done.
		editing.execute({ type: "equation.insert", latex: "x^2", display: false })

		const pressed = renderPopover(editing, { request: "equation.insert" })

		expect(screen.getByRole("dialog", { name: "Insert equation" })).toBeTruthy()
		pressed.press(pressOn(equationAt(editing)))
		await waitFor(() => {
			expect(pressed.onInputDone).toHaveBeenCalledWith(7)
		})
		expect(screen.getByRole("dialog", { name: "Edit equation" })).toBeTruthy()
		expect(field().value).toBe("x^2")
	})

	it("says what is wrong with the LaTeX, where, and inserts nothing", async () => {
		const editing = await session()
		const { execute } = renderPopover(editing, { request: "equation.insert" })

		fireEvent.change(field(), { target: { value: "x + \\frac{a}" } })
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("\\frac is missing its argument (at character 5).")
		})
		expect(screen.getByRole("button", { name: "Insert" })).toHaveProperty("disabled", true)
		fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true })
		expect(execute).not.toHaveBeenCalled()
	})

	it("edits a pressed equation: selected first, its LaTeX given, an unchanged one left as it is", async () => {
		const editing = await session()

		expect(editing.execute({ type: "equation.insert", latex: "x^2", display: false })).toBe(true)

		const pos = equationAt(editing)
		const { execute, onPressDone } = renderPopover(editing, { press: pressOn(pos) })

		expect(screen.getByRole("dialog", { name: "Edit equation" })).toBeTruthy()
		expect(field().value).toBe("x^2")
		await waitFor(() => {
			expect(onPressDone).toHaveBeenCalledTimes(1)
		})
		expect(editing.snapshot().context.equation?.pos).toBe(pos)

		// Unchanged: nothing to do.
		fireEvent.click(screen.getByRole("button", { name: "Update" }))
		expect(execute).not.toHaveBeenCalled()
	})

	it("updates an equation with Ctrl+Enter, and cancels with Esc", async () => {
		const editing = await session()

		editing.execute({ type: "equation.insert", latex: "x^2", display: false })

		const pos = equationAt(editing)
		const first = renderPopover(editing, { press: pressOn(pos) })

		fireEvent.change(field(), { target: { value: "x^3" } })
		// Mod is the platform's own and the chord exact; an input method's Enter is its own.
		fireEvent.keyDown(field(), { key: "Enter", code: "Enter", metaKey: true })
		fireEvent.keyDown(field(), { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true })
		fireEvent.keyDown(field(), { key: "Enter", code: "Enter", ctrlKey: true, isComposing: true })
		expect(first.execute).not.toHaveBeenCalled()
		fireEvent.keyDown(field(), { key: "Enter", code: "Enter", ctrlKey: true })
		expect(first.execute).toHaveBeenCalledWith({ type: "equation.edit", latex: "x^3" })

		cleanup()

		const second = renderPopover(editing, { press: pressOn(pos) })

		fireEvent.change(field(), { target: { value: "y" } })
		fireEvent.keyDown(field(), { key: "Escape" })
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(second.execute).not.toHaveBeenCalled()
	})

	it("edits an equation while changes are tracked (recorded inside it)", async () => {
		const editing = await session()

		editing.execute({ type: "equation.insert", latex: "x^2", display: false })
		editing.context.review.tracking = true
		editing.context.identity.author = "Ada"

		const { execute } = renderPopover(editing, { press: pressOn(equationAt(editing)) })

		expect(screen.getByRole("dialog", { name: "Edit equation" })).toBeTruthy()
		fireEvent.change(field(), { target: { value: "x^3" } })
		fireEvent.click(screen.getByRole("button", { name: "Update" }))
		expect(execute).toHaveBeenCalledWith({ type: "equation.edit", latex: "x^3" })
	})

	it("warns that an equation the subset cannot say is simplified by an update", async () => {
		const editing = await session()

		editing.dispatch(editing.state.tr.insert(1, docxSchema.nodes.math.create({ src: -1, omml: LOSSY })))
		renderPopover(editing, { press: pressOn(equationAt(editing)) })

		expect(screen.getByText(/simplifies this equation/)).toBeTruthy()
	})

	it("shows the LaTeX of a selected equation that cannot change, read-only", async () => {
		const editing = await session()

		editing.execute({ type: "equation.insert", latex: "\\sqrt{2}", display: false })
		expect(selectEquation(editing, equationAt(editing))).toBe(true)

		const { execute } = renderPopover(editing, { readOnly: true })

		expect(screen.getByRole("dialog", { name: "Equation" })).toBeTruthy()
		expect(field().value).toBe("\\sqrt{2}")
		expect(field().readOnly).toBe(true)
		expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Close" }))
		expect(screen.queryByRole("dialog")).toBeNull()
		expect(execute).not.toHaveBeenCalled()
	})
})
