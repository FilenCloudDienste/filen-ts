// @vitest-environment happy-dom
import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { NO_VALUES } from "@filen/office/core/docx/edit"
import { renderRibbon, ribbonSnapshot } from "@/tests/docxRibbonHarness"

// Word's Font and Font Size boxes are editable: a size or font name typed applies on Enter or on leaving the box, a
// size Word refuses (no number, outside 1 to 1638 pt) leaves the formatting alone and the box showing the size in
// effect, and Escape drops what was typed.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

afterEach(() => {
	cleanup()
})

function box(name: string): HTMLInputElement {
	const element = screen.getByRole("combobox", { name })

	if (!(element instanceof HTMLInputElement)) {
		throw new Error(`${name} is no input`)
	}

	return element
}

function type(element: HTMLInputElement, text: string): void {
	element.focus()
	fireEvent.change(element, { target: { value: text } })
}

describe("The Font and Font Size boxes", () => {
	it("apply a size typed outside the list on Enter, in half-points", () => {
		const { execute } = renderRibbon()
		const size = box("Font size")

		type(size, "13")
		expect(size.value).toBe("13")
		fireEvent.keyDown(size, { key: "Enter" })
		expect(execute).toHaveBeenCalledWith({ type: "font.size", halfPoints: 26 })
		execute.mockClear()
		type(size, "10,5")
		fireEvent.keyDown(size, { key: "Enter" })
		expect(execute).toHaveBeenCalledWith({ type: "font.size", halfPoints: 21 })
	})

	it("apply a size above the list's 72 pt when the box is left", () => {
		const { execute } = renderRibbon()
		const size = box("Font size")

		type(size, "200")
		fireEvent.blur(size)
		expect(execute).toHaveBeenCalledWith({ type: "font.size", halfPoints: 400 })
	})

	it("refuse a size outside 1 to 1638 pt or no number, showing the size in effect again", () => {
		const { execute } = renderRibbon()
		const size = box("Font size")

		for (const text of ["2000", "0", "abc"]) {
			type(size, text)
			fireEvent.keyDown(size, { key: "Enter" })
			expect(size.value).toBe("11")
		}

		expect(execute).not.toHaveBeenCalled()
	})

	it("drop what was typed on Escape", () => {
		const { execute } = renderRibbon()
		const size = box("Font size")

		type(size, "13")
		fireEvent.keyDown(size, { key: "Escape" })
		expect(size.value).toBe("11")
		fireEvent.blur(size)
		expect(execute).not.toHaveBeenCalled()
	})

	it("show a size outside the list, and nothing for several", () => {
		renderRibbon({ snapshot: ribbonSnapshot({ values: { ...NO_VALUES, size: 26 } }) })
		expect(box("Font size").value).toBe("13")
		cleanup()
		renderRibbon({ snapshot: ribbonSnapshot({ values: { ...NO_VALUES, size: "mixed" } }) })
		expect(box("Font size").value).toBe("")
	})

	it("apply a font name typed: a listed one by its label, any other as itself", () => {
		const { execute } = renderRibbon()
		const font = box("Font")

		type(font, "Comic Sans MS")
		fireEvent.keyDown(font, { key: "Enter" })
		expect(execute).toHaveBeenCalledWith({ type: "font.family", family: "Comic Sans MS" })
		execute.mockClear()
		type(font, "calibri (body)")
		fireEvent.keyDown(font, { key: "Enter" })
		expect(execute).toHaveBeenCalledWith({ type: "font.family", family: "+body" })
	})

	it("narrow the font list to what is typed, Enter completing it to the first match", async () => {
		const { execute } = renderRibbon()

		const font = box("Font")

		font.focus()
		// Typed (an input type), which opens the list as autofill does not.
		fireEvent.input(font, { target: { value: "ar" }, inputType: "insertText" })

		const options = (await screen.findAllByRole("option")).map(option => option.textContent)

		expect(options).toEqual(["Arial"])
		await waitFor(() => {
			expect(screen.getByRole("option", { name: "Arial" }).hasAttribute("data-highlighted")).toBe(true)
		})
		fireEvent.keyDown(font, { key: "Enter" })
		expect(execute).toHaveBeenCalledTimes(1)
		expect(execute).toHaveBeenCalledWith({ type: "font.family", family: "Arial" })
	})
})
