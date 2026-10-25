// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { DOCX_VIEWER_CAPABILITIES, type DocxViewerCommand, type DocxViewerState } from "@filen/office/dom/docx"
import "@/lib/i18n"

// The Word viewer's command bar as the row narrows: groups collapse and then move into More commands by priority,
// the pages and find always stay in the row; on a phone the page group drops first and last and the status keeps
// only its badges. The page field and the zoom menu drive the viewer's own commands.

const size = vi.hoisted(() => ({ width: 2000 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))

const { DocxToolbar } = await import("@/features/preview/components/docxToolbar")

const STATE: DocxViewerState = {
	status: "ready",
	capabilities: DOCX_VIEWER_CAPABILITIES,
	page: 1,
	pageCount: 5,
	pageCountFinal: true,
	zoom: 0.5,
	zoomMode: "custom",
	find: { open: false, query: "", caseSensitive: false, count: 0, capped: false, active: -1 }
}

function phone(matches: boolean): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches, addEventListener: () => undefined, removeEventListener: () => undefined }))
	)
}

function bar(dispatch: (command: DocxViewerCommand) => void): HTMLElement {
	render(
		<DocxToolbar
			state={STATE}
			dispatch={dispatch}
			markup="simple"
			onMarkupChange={() => undefined}
			viewOnly={["trash"]}
			findFocus={0}
			onFindClosed={() => undefined}
		/>
	)

	return screen.getByRole("toolbar", { name: "Commands" })
}

afterEach(() => {
	size.width = 2000
})

describe("DocxToolbar as a command bar", () => {
	it("shows every group in a wide row, one Tab stop", () => {
		phone(false)

		const row = bar(() => undefined)

		for (const group of ["Pages", "Zoom", "Markup", "Find"]) {
			expect(within(row).getByRole("group", { name: group })).toBeTruthy()
		}

		expect(within(row).getByRole("button", { name: "First page" })).toBeTruthy()
		expect(within(row).queryByRole("button", { name: "More commands" })).toBeNull()
		expect(row.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
	})

	it("moves the lower groups into More commands as the row narrows, keeping the pages and find", () => {
		phone(false)
		size.width = 330

		const row = bar(() => undefined)

		expect(within(row).getByRole("group", { name: "Pages" })).toBeTruthy()
		expect(within(row).getByRole("group", { name: "Find" })).toBeTruthy()
		expect(within(row).queryByRole("group", { name: "Zoom" })).toBeNull()
		expect(within(row).getByRole("button", { name: "More commands" })).toBeTruthy()
	})

	it("on a phone drops first and last, and keeps only the badges in the status", () => {
		phone(true)

		const row = bar(() => undefined)

		expect(within(row).queryByRole("button", { name: "First page" })).toBeNull()
		expect(within(row).getByRole("button", { name: "Previous page" })).toBeTruthy()
		expect(screen.getByText("Page 2 of 5").parentElement?.className).toContain("max-sm:hidden")
		expect(screen.getByRole("button", { name: "View only" })).toBeTruthy()
	})

	it("goes to a typed page and sets the zoom from its menu", async () => {
		phone(false)

		const dispatch = vi.fn()

		bar(dispatch)

		const field = screen.getByRole("textbox", { name: "Page number" })

		fireEvent.change(field, { target: { value: "4" } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(dispatch).toHaveBeenLastCalledWith({ type: "page.goto", page: 3 })

		fireEvent.click(screen.getByRole("button", { name: "Zoom level, 50%" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "150%" }))
		expect(dispatch).toHaveBeenLastCalledWith({ type: "zoom.set", zoom: 1.5 })

		fireEvent.click(screen.getByRole("button", { name: "Zoom level, 50%" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Fit to width" }))
		expect(dispatch).toHaveBeenLastCalledWith({ type: "zoom.fitWidth" })
	})
})
