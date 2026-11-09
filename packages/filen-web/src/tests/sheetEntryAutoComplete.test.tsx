// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type { SheetSessionApi } from "@filen/office/core/sheet"
import type { GridEditing, SheetGridModel } from "@filen/office/react/sheet"
import { useEntryAutoComplete } from "@/features/spreadsheet/formulaBar/autoComplete"

// AutoComplete in the entry: a typed character at the end of a text entry fills in the one column entry starting with
// it, the rest selected; nothing for a formula, a deletion, a composition, or more than one match.

afterEach(() => {
	cleanup()
})

function entry(text: string, mode: GridEditing["mode"] = "enter"): GridEditing {
	return { sheet: 0, row: 5, col: 1, text, initial: null, fromInput: false, mode, invalid: false }
}

function setup(entries: readonly string[], opened: GridEditing | null = null) {
	let editing = opened
	const model = {
		getSnapshot: () => ({ editing }),
		setEditText: vi.fn((text: string) => {
			if (editing !== null) editing = { ...editing, text }
		})
	} as unknown as SheetGridModel
	const query = vi.fn().mockResolvedValue({ entries: entries.map(text => ({ text, input: text })) })
	const session = { query } as unknown as SheetSessionApi
	const editor = document.createElement("textarea")

	editor.setAttribute("data-sheet-editor", "")
	editor.value = opened?.text ?? ""
	document.body.append(editor)
	editor.focus()

	function Harness() {
		useEntryAutoComplete({ model, session, canEdit: true, editing: opened ?? entry("") })

		return null
	}

	render(<Harness />)

	// Types `text` at the end, as the editor's own handler then gives it to the entry.
	async function type(text: string, inputType = "insertText"): Promise<void> {
		await act(async () => {
			editor.value = editor.value.slice(0, editor.selectionStart) + text
			editor.setSelectionRange(editor.value.length, editor.value.length)
			editing = entry(editor.value)
			editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }))
			await Promise.resolve()
			await Promise.resolve()
		})
	}

	return { editor, model, query, type, current: () => editing }
}

describe("AutoComplete in the entry", () => {
	it("completes from the one matching entry, the rest selected, once the entries arrive", async () => {
		const { editor, query, type, current } = setup(["Apple", "Banana", "Apricot"])

		await type("b")

		expect(query).toHaveBeenCalledWith("autoComplete.entries", { sheet: 0, row: 5, col: 1 })
		expect(editor.value).toBe("banana")
		expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 6])
		expect(current()?.text).toBe("banana")
	})

	it("reads the entries once per entry and completes only when one entry matches", async () => {
		const { editor, query, type } = setup(["Apple", "Banana", "Apricot"])

		await type("a")

		expect(editor.value).toBe("a")

		await type("p")

		expect(editor.value).toBe("ap")

		await type("r")

		expect(editor.value).toBe("apricot")
		expect(query).toHaveBeenCalledTimes(1)
	})

	it("leaves a formula, a deletion and a composition as typed", async () => {
		const { editor, type } = setup(["=SUM", "Banana"])

		await type("b", "insertCompositionText")

		expect(editor.value).toBe("b")

		await type("", "deleteContentBackward")

		expect(editor.value).toBe("b")

		editor.value = ""
		await type("=")

		expect(editor.value).toBe("=")
	})

	it("completes an entry opened by typing its first character", async () => {
		const { editor } = setup(["Banana"], entry("b"))

		await act(async () => {
			await Promise.resolve()
			await Promise.resolve()
		})

		expect(editor.value).toBe("banana")
		expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 6])
	})
})
