// @vitest-environment jsdom

// Render cases for the checklist editor's own key and hide-completed handling, which the pure row
// transforms (notesChecklistEditor.test.ts) cannot reach.
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import { createElement } from "react"
import { checklistParser } from "@filen/shared"
import "@/lib/i18n"
import { ChecklistEditor } from "@/features/notes/components/editor/checklistEditor"
import { serializeChecklist } from "@/features/notes/components/editor/checklistEditor.logic"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"

function controllerFor(seed: string, onChange: (value: string) => void): NoteEditorController {
	return {
		status: "ready",
		errorDto: undefined,
		seed,
		remountKey: "key",
		readOnly: false,
		isInflight: false,
		sizeReached: false,
		onChange
	}
}

function seedOf(rows: { checked: boolean; content: string }[]): string {
	return serializeChecklist(rows.map((row, index) => ({ id: String(index), ...row })))
}

function renderEditor(seed: string, hideCompleted = false) {
	const onChange = vi.fn<(value: string) => void>()

	render(createElement(ChecklistEditor, { controller: controllerFor(seed, onChange), hideCompleted }))

	return onChange
}

function inputs(): HTMLInputElement[] {
	return screen.queryAllByRole("textbox")
}

function lastContents(onChange: ReturnType<typeof renderEditor>): { checked: boolean; content: string }[] {
	const value = onChange.mock.lastCall?.[0] ?? ""

	return checklistParser.parse(value).map(({ checked, content }) => ({ checked, content }))
}

function nextFrame(): Promise<void> {
	return new Promise(resolve => {
		requestAnimationFrame(() => {
			resolve()
		})
	})
}

afterEach(() => {
	cleanup()
})

describe("ChecklistEditor — IME Enter", () => {
	it("adds no row for the Enter that confirms a conversion (composing, or Safari's keyCode 229)", () => {
		const onChange = renderEditor(seedOf([{ checked: false, content: "日本" }]))
		const [row] = inputs()

		if (!row) {
			throw new Error("no row rendered")
		}

		fireEvent.keyDown(row, { key: "Enter", isComposing: true })
		fireEvent.keyDown(row, { key: "Enter", keyCode: 229 })

		expect(inputs()).toHaveLength(1)
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.keyDown(row, { key: "Enter", keyCode: 13 })

		expect(inputs()).toHaveLength(2)
	})
})

describe("ChecklistEditor — hide completed", () => {
	it("keeps a ghost row when every item is hidden, which becomes a real item once typed into", () => {
		const onChange = renderEditor(seedOf([{ checked: true, content: "done" }]), true)
		const [ghost] = inputs()

		if (!ghost) {
			throw new Error("no ghost row rendered")
		}

		expect(onChange).not.toHaveBeenCalled()

		ghost.focus()
		fireEvent.change(ghost, { target: { value: "n" } })

		expect(lastContents(onChange)).toEqual([
			{ checked: true, content: "done" },
			{ checked: false, content: "n" }
		])
		// The materialized item keeps the ghost's input, so typing carries on uninterrupted.
		expect(inputs()).toEqual([ghost])
		expect(document.activeElement).toBe(ghost)
	})

	it("shows the ghost row once the last visible item is checked off", () => {
		renderEditor(seedOf([{ checked: false, content: "last" }]), true)

		fireEvent.click(screen.getByRole("checkbox"))

		const rows = inputs()

		expect(rows).toHaveLength(1)
		expect(rows[0]?.value).toBe("")
	})

	it("moves focus past a hidden previous row on Backspace", () => {
		renderEditor(
			seedOf([
				{ checked: false, content: "open" },
				{ checked: true, content: "done" },
				{ checked: false, content: "" }
			]),
			true
		)
		const [open, empty] = inputs()

		if (!open || !empty) {
			throw new Error("rows not rendered")
		}

		fireEvent.keyDown(empty, { key: "Backspace" })

		expect(inputs()).toEqual([open])
		expect(document.activeElement).toBe(open)
	})

	it("focuses the ghost row when a Backspace leaves nothing visible", async () => {
		const onChange = renderEditor(
			seedOf([
				{ checked: true, content: "done" },
				{ checked: false, content: "" }
			]),
			true
		)
		const [empty] = inputs()

		if (!empty) {
			throw new Error("row not rendered")
		}

		fireEvent.keyDown(empty, { key: "Backspace" })
		await nextFrame()

		expect(lastContents(onChange)).toEqual([{ checked: true, content: "done" }])

		const [ghost] = inputs()

		expect(ghost?.value).toBe("")
		expect(document.activeElement).toBe(ghost)
	})
})
