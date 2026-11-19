// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DocxCurrentPageSetup, PagedEditor } from "@filen/office/core/docx/paged"
import "@/lib/i18n"

// Page setup as one dialog: prefilled lengths kept to the twip whatever two fields show, negative top and
// bottom margins, Custom staying chosen, "Whole document" applying the section's setup everywhere, and a
// refusal keeping the dialog open with why.

const setup = vi.hoisted(() => ({ current: undefined as DocxCurrentPageSetup | undefined }))

vi.mock("@filen/office/core/docx/paged", async () => ({
	...(await vi.importActual<typeof import("@filen/office/core/docx/paged")>("@filen/office/core/docx/paged")),
	currentPageSetup: () => setup.current
}))

const { DocxPageSetupDialog } = await import("@/features/preview/components/docxPageSetupDialog")

const LETTER: DocxCurrentPageSetup = {
	size: { width: 12_240, height: 15_840 },
	orientation: "portrait",
	// 1440 and 1441 twips both show as 1".
	margins: { top: 1440, bottom: 1440, left: 1441, right: 1440, header: 720, footer: 720, gutter: 0 },
	columns: { count: 1, space: 720, separator: false },
	mirrorMargins: false,
	pageNumbers: { start: null, format: "decimal" },
	lineNumbers: null
}

function renderDialog(applies = true) {
	setup.current = LETTER

	const execute = vi.fn(() => applies)
	const onInputDone = vi.fn()
	// No snapshot read while rendering: whether page.setup can run comes from the toolbar's.
	const editor = { execute } as unknown as PagedEditor

	vi.spyOn(navigator, "language", "get").mockReturnValue("en-US")
	render(
		<DocxPageSetupDialog
			editor={editor}
			readOnly={false}
			enabled
			inputRequest={{ type: "page.setup", nonce: 4 }}
			requestInput={vi.fn()}
			onInputDone={onInputDone}
		/>
	)

	return { execute, onInputDone }
}

afterEach(() => {
	cleanup()
})

// Picks a select's option as a mouse does.
function choose(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(option, { button: 0 })
	fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(option, { button: 0 })
	fireEvent.click(option)
}

describe("DocxPageSetupDialog", () => {
	it("reads lengths left as shown to the twip, each field its own", () => {
		const { execute } = renderDialog()

		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Top (in)" }).value).toBe("1")
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Left (in)" }).value).toBe("1")
		// Nothing changed: nothing to apply (the top is not read as the left's 1441).
		expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true)
		fireEvent.change(screen.getByRole("textbox", { name: "Right (in)" }), { target: { value: "1.5" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledWith({
			type: "page.setup",
			margins: { top: 1440, bottom: 1440, left: 1441, right: 2160 },
			scope: "section"
		})
	})

	it("takes negative top and bottom margins, never negative sides", () => {
		const { execute } = renderDialog()

		fireEvent.change(screen.getByRole("textbox", { name: "Top (in)" }), { target: { value: "-0.5" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute.mock.lastCall).toMatchObject([{ margins: { top: -720 } }])

		fireEvent.change(screen.getByRole("textbox", { name: "Left (in)" }), { target: { value: "-1" } })
		expect(screen.getByText("Some sizes aren't valid.")).toBeTruthy()
	})

	it("keeps Custom chosen for the paper and margins, and offers Office 2003 Default", async () => {
		renderDialog()

		fireEvent.click(screen.getByRole("combobox", { name: "Margins" }))
		expect(await screen.findByRole("option", { name: "Office 2003 Default" })).toBeTruthy()
		choose(screen.getByRole("option", { name: "Custom" }))
		expect(screen.getByRole("combobox", { name: "Margins" }).textContent).toContain("Custom")

		fireEvent.click(screen.getByRole("combobox", { name: "Paper size" }))
		choose(await screen.findByRole("option", { name: "Custom" }))
		expect(screen.getByRole("combobox", { name: "Paper size" }).textContent).toContain("Custom")
	})

	it("sets Word's Mirrored margins: inside and outside, with mirror margins on", async () => {
		const { execute } = renderDialog()

		fireEvent.click(screen.getByRole("combobox", { name: "Margins" }))
		choose(await screen.findByRole("option", { name: "Mirrored" }))
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Inside (in)" }).value).toBe("1.25")
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Outside (in)" }).value).toBe("1")
		expect(screen.getByRole("switch", { name: "Mirror margins" }).getAttribute("aria-checked")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledWith({
			type: "page.setup",
			margins: { top: 1440, bottom: 1440, left: 1800, right: 1440 },
			mirrorMargins: true,
			scope: "section"
		})

		// Another preset turns them off again, as Word's gallery does.
		fireEvent.click(screen.getByRole("combobox", { name: "Margins" }))
		choose(await screen.findByRole("option", { name: "Normal" }))
		expect(screen.getByRole("switch", { name: "Mirror margins" }).getAttribute("aria-checked")).toBe("false")
		expect(screen.getByRole("textbox", { name: "Left (in)" })).toBeTruthy()
	})

	it("applies the section's setup to every section for Whole document, nothing else changed", async () => {
		const { execute } = renderDialog()

		fireEvent.click(screen.getByRole("combobox", { name: "Apply to" }))
		choose(await screen.findByRole("option", { name: "Whole document" }))
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledWith({
			type: "page.setup",
			size: { width: 12_240, height: 15_840 },
			orientation: "portrait",
			margins: { top: 1440, bottom: 1440, left: 1441, right: 1440 },
			columns: { count: 1 },
			lineNumbers: null,
			scope: "document"
		})
	})

	it("turns the page landscape when the typed width is the longer side, the margins as shown", () => {
		const { execute } = renderDialog()

		fireEvent.change(screen.getByRole("textbox", { name: "Width (in)" }), { target: { value: "11" } })
		fireEvent.change(screen.getByRole("textbox", { name: "Height (in)" }), { target: { value: "8.5" } })
		expect(screen.getByRole("combobox", { name: "Orientation" }).textContent).toContain("Landscape")
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledWith({
			type: "page.setup",
			size: { width: 12_240, height: 15_840 },
			orientation: "landscape",
			margins: { top: 1440, bottom: 1440, left: 1441, right: 1440 },
			scope: "section"
		})
	})

	it("keeps the chosen orientation for a square paper", () => {
		const { execute } = renderDialog()

		fireEvent.change(screen.getByRole("textbox", { name: "Width (in)" }), { target: { value: "11" } })
		expect(screen.getByRole("combobox", { name: "Orientation" }).textContent).toContain("Portrait")
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute.mock.lastCall).toMatchObject([{ size: { width: 15_840, height: 15_840 }, orientation: "portrait" }])
	})

	it("never turns the margins while a length is typed digit by digit", () => {
		const { execute } = renderDialog()
		const width = screen.getByRole("textbox", { name: "Width (in)" })

		fireEvent.change(screen.getByRole("textbox", { name: "Right (in)" }), { target: { value: "1.5" } })
		fireEvent.change(screen.getByRole("textbox", { name: "Height (in)" }), { target: { value: "8.5" } })

		for (const text of ["1", "11", "1", "11"]) {
			fireEvent.change(width, { target: { value: text } })
		}

		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Top (in)" }).value).toBe("1")
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Right (in)" }).value).toBe("1.5")
		expect(screen.getByRole("combobox", { name: "Orientation" }).textContent).toContain("Landscape")
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute.mock.lastCall).toMatchObject([
			{ orientation: "landscape", margins: { top: 1440, bottom: 1440, left: 1441, right: 2160 } }
		])
	})

	it("stays open and says so when the document refuses the settings", () => {
		const { execute, onInputDone } = renderDialog(false)

		fireEvent.change(screen.getByRole("textbox", { name: "Bottom (in)" }), { target: { value: "2" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledTimes(1)
		expect(onInputDone).not.toHaveBeenCalled()
		expect(screen.getByRole("alert").textContent).toBe("These settings can't be saved in this document. Try other values.")
	})
})
