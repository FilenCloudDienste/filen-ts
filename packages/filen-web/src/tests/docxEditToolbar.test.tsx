// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { NO_VALUES } from "@filen/office/core/docx/edit"
import { themeSwatches } from "@/features/preview/components/docxEditor.logic"
import { createDocxPageStore, goToPageIndex } from "@/features/preview/components/docxGoTo.logic"
import { registerAllActions } from "@/lib/keymap/actions"
import { PICTURE, TABLE, renderRibbon, ribbonSnapshot, ribbonSnapshotIn } from "@/tests/docxRibbonHarness"

// The Word editor's ribbon on its own: its tabs and Home's groups in Word's order, the formatting controls showing the
// selection's values and turning off with their commands, the clipboard, the colour pickers and the format painter,
// every tab's commands, the contextual Table and Picture tabs, and the groups collapsing as the row narrows.

const size = vi.hoisted(() => ({ width: 2000 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

registerAllActions()

afterEach(() => {
	cleanup()
	size.width = 2000
	vi.restoreAllMocks()
})

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

function tab(name: string): void {
	fireEvent.click(screen.getByRole("tab", { name }))
}

describe("DocxEditToolbar", () => {
	it("shows Word's tabs, the contextual ones only with their object, and Home's groups in order", () => {
		renderRibbon()

		expect(screen.getAllByRole("tab").map(entry => entry.textContent)).toEqual([
			"Home",
			"Insert",
			"Layout",
			"References",
			"Review",
			"View"
		])
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Undo", "Clipboard", "Font", "Formatting", "Paragraph", "Styles", "Editing"])
		cleanup()

		renderRibbon({ snapshot: ribbonSnapshotIn({ table: TABLE, drawing: PICTURE }) })
		expect(screen.getAllByRole("tab").map(entry => entry.textContent)).toEqual([
			"Home",
			"Insert",
			"Layout",
			"References",
			"Review",
			"View",
			"Table",
			"Picture"
		])
	})

	it("offers only the paragraph styles the document's protection leaves open", async () => {
		renderRibbon()

		fireEvent.click(screen.getByRole("combobox", { name: "Paragraph style" }))

		const options = (await screen.findAllByRole("option")).map(option => option.textContent)

		expect(options).toEqual(["Normal", "Heading 1", "Heading 2"])
	})

	it("shows the selection's font and size, and nothing for several", () => {
		// Editable boxes, as Word's: the value is the field's; several fonts leave it empty with a hint.
		const field = (name: string): HTMLInputElement => {
			const element = screen.getByRole("combobox", { name })

			if (!(element instanceof HTMLInputElement)) {
				throw new Error(`${name} is no field`)
			}

			return element
		}

		renderRibbon()

		expect(field("Font").value).toBe("Georgia")
		expect(field("Font size").value).toBe("11")
		cleanup()
		renderRibbon({ snapshot: ribbonSnapshot({ values: { ...NO_VALUES, font: "mixed", size: "mixed" } }) })
		expect(field("Font").value).toBe("")
		expect(field("Font").placeholder).toContain("Several")
		expect(field("Font size").value).toBe("")
		cleanup()
		renderRibbon({ snapshot: ribbonSnapshot({ values: { ...NO_VALUES, font: "Calibri", size: 21 } }) })
		expect(field("Font").value).toBe("Calibri (Body)")
		expect(field("Font size").value).toMatch(/^10[.,]5$/)
	})

	it("turns each control off with its command (direct formatting under formatting restrictions), and when read-only", () => {
		const enabled = ribbonSnapshot().enabled

		renderRibbon({
			snapshot: ribbonSnapshot({
				enabled: { ...enabled, "font.family": false, "font.size": false, "color.text": false, "format.subscript": false }
			})
		})
		expect(screen.getByRole("combobox", { name: "Font" }).hasAttribute("data-disabled")).toBe(true)
		expect(screen.getByRole("combobox", { name: "Font size" }).hasAttribute("data-disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Font color" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Subscript" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Highlight color" }).hasAttribute("disabled")).toBe(false)
		cleanup()
		renderRibbon({ readOnly: true })
		expect(screen.getByRole("button", { name: "Highlight color" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Format painter" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Cut" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Paste" }).hasAttribute("disabled")).toBe(true)
		// Copying changes nothing.
		expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(false)
	})

	it("pastes the clipboard as it is or its text only, cuts and copies, with their shortcuts", async () => {
		const { clipboard } = renderRibbon()

		fireEvent.click(screen.getByRole("button", { name: "Paste" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Keep text only" }))
		expect(clipboard.paste).toHaveBeenLastCalledWith(true)
		fireEvent.click(screen.getByRole("button", { name: "Paste" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Paste" }))
		expect(clipboard.paste).toHaveBeenLastCalledWith(false)
		fireEvent.click(screen.getByRole("button", { name: "Cut" }))
		fireEvent.click(screen.getByRole("button", { name: "Copy" }))
		expect(clipboard.cut).toHaveBeenCalledTimes(1)
		expect(clipboard.copy).toHaveBeenCalledTimes(1)
	})

	it("runs the size steps, subscript and superscript, and the formatting menu's caps", async () => {
		const { execute } = renderRibbon({ snapshot: ribbonSnapshot({ values: { ...NO_VALUES, vertAlign: "superscript" } }) })

		fireEvent.click(screen.getByRole("button", { name: "Increase font size" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "font.grow" })
		fireEvent.click(screen.getByRole("button", { name: "Subscript" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "format.subscript" })
		expect(screen.getByRole("button", { name: "Superscript" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "More formatting" }))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Small caps" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "format.smallCaps" })
		// The menu closes with the format applied, in every browser (not by focus leaving it).
		await waitFor(() => {
			expect(screen.queryByRole("menuitemcheckbox", { name: "Small caps" })).toBeNull()
		})
	})

	it("sets a theme, standard or automatic text colour and a highlight from the shared pickers", async () => {
		const { execute } = renderRibbon()

		fireEvent.click(screen.getByRole("button", { name: "Font color" }))
		fireEvent.click(await screen.findByRole("button", { name: "Accent 1, lighter 60%" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "color.text", color: { kind: "theme", theme: "accent1", tint: 102 } })

		fireEvent.click(screen.getByRole("button", { name: "Font color" }))
		fireEvent.click(await screen.findByRole("button", { name: "Dark red" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "color.text", color: { kind: "rgb", value: "C00000" } })

		fireEvent.click(screen.getByRole("button", { name: "Font color" }))
		fireEvent.click(await screen.findByRole("button", { name: "Automatic" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "color.text", color: { kind: "auto" } })

		fireEvent.click(screen.getByRole("button", { name: "Highlight color" }))
		fireEvent.click(await screen.findByRole("button", { name: "Turquoise" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "color.highlight", name: "cyan" })
	})

	it("picks up formatting with a click, keeps it with a double click, and a click while on turns it off", () => {
		const { execute, onPainterCancel } = renderRibbon()
		const painter = screen.getByRole("button", { name: "Format painter" })

		fireEvent.click(painter, { detail: 1 })
		expect(execute).toHaveBeenLastCalledWith({ type: "format.copy" })
		fireEvent.click(painter, { detail: 2 })
		expect(execute).toHaveBeenLastCalledWith({ type: "format.copy", sticky: true })
		cleanup()

		const on = renderRibbon({ painter: "sticky" })

		expect(screen.getByRole("button", { name: "Format painter (on until clicked again)" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "Format painter (on until clicked again)" }), { detail: 1 })
		expect(on.onPainterCancel).toHaveBeenCalledTimes(1)
		expect(on.execute).not.toHaveBeenCalled()
		expect(onPainterCancel).not.toHaveBeenCalled()
	})

	it("sets line spacing, opens the Paragraph dialog and find or find and replace from Home", async () => {
		const { execute, requestInput, onFindOpen } = renderRibbon()

		fireEvent.click(screen.getByRole("button", { name: "Line spacing" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "1.5" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "paragraph.lineSpacing", rule: "auto", value: 360 })
		fireEvent.click(screen.getByRole("button", { name: "Paragraph…" }))
		expect(requestInput).toHaveBeenLastCalledWith("paragraph.indent")
		fireEvent.click(screen.getByRole("button", { name: "Find in document" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Find and replace" }))
		expect(onFindOpen).toHaveBeenLastCalledWith(true)
	})

	it("swaps the command row for the find field while find is open", () => {
		const base = renderRibbon()

		base.unmount()
		renderRibbon({
			find: {
				open: true,
				replace: false,
				focus: 0,
				controls: {
					query: "",
					caseSensitive: false,
					count: 0,
					capped: false,
					active: -1,
					search: vi.fn(),
					step: vi.fn(),
					close: vi.fn(),
					replace: { disabled: true, one: vi.fn(), all: vi.fn() }
				}
			}
		})
		expect(screen.queryByRole("toolbar", { name: "Commands" })).toBeNull()
		expect(screen.getByRole("searchbox", { name: "Find" })).toBeTruthy()
	})

	it("inserts from the Insert tab: a table of the size picked, a link, a picture, a page break", async () => {
		const { execute, requestInput } = renderRibbon()

		tab("Insert")
		fireEvent.click(await screen.findByRole("button", { name: "Table" }))
		fireEvent.click(await screen.findByRole("button", { name: "3 × 2 table" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.insert", cols: 3, rows: 2 })
		fireEvent.click(screen.getByRole("button", { name: "Link…" }))
		expect(requestInput).toHaveBeenLastCalledWith("link.set", undefined)
		fireEvent.click(screen.getByRole("button", { name: "Picture" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "From Filen drive…" }))
		expect(requestInput).toHaveBeenLastCalledWith("image.insert", "drive")
		fireEvent.click(screen.getByRole("button", { name: "Page break" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "insert.pageBreak" })
		fireEvent.click(screen.getByRole("button", { name: "New comment" }))
		expect(requestInput).toHaveBeenLastCalledWith("comment.add")
	})

	it("offers no header or footer editing in Mobile view, which shows neither", () => {
		for (const surface of ["pages", "reflow"] as const) {
			renderRibbon({ surface, reflow: surface === "reflow" })
			tab("Insert")
			expect(screen.queryByRole("button", { name: "Header" }) !== null).toBe(surface === "pages")
			expect(screen.queryByRole("button", { name: "Footer" }) !== null).toBe(surface === "pages")
			cleanup()
		}
	})

	it("offers nothing that writes on the Insert tab while read-only", () => {
		renderRibbon({ readOnly: true })
		tab("Insert")
		expect(screen.getByRole("button", { name: "Horizontal line" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Link…" }).hasAttribute("disabled")).toBe(true)
	})

	it("sets up the pages, breaks and paragraphs from the Layout tab, and notes and fields from References", async () => {
		const { execute, requestInput } = renderRibbon()

		tab("Layout")
		fireEvent.click(screen.getByRole("button", { name: "Page setup…" }))
		expect(requestInput).toHaveBeenLastCalledWith("page.setup")
		fireEvent.click(screen.getByRole("button", { name: "Breaks" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Line break" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "insert.lineBreak" })

		tab("References")
		fireEvent.click(screen.getByRole("button", { name: "Footnote" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "note.insertFootnote" })
		fireEvent.click(screen.getByRole("button", { name: "Update all fields" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "field.updateAll" })
		fireEvent.click(screen.getByRole("button", { name: "Table of contents…" }))
		expect(requestInput).toHaveBeenLastCalledWith("toc.insert", undefined)
	})

	it("switches track changes and the markup from the Review tab, the markup only where there is any", async () => {
		const onMarkupChange = vi.fn()
		const { execute } = renderRibbon({ markup: "simple", onMarkupChange })

		tab("Review")
		fireEvent.click(screen.getByRole("button", { name: "Track changes" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "review.track", on: true })
		fireEvent.click(screen.getByRole("button", { name: "Markup" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "All markup" }))
		expect(onMarkupChange).toHaveBeenLastCalledWith("all")
		// Accepting the change at the caret needs one there.
		fireEvent.click(screen.getByRole("button", { name: "Accept" }))
		expect((await screen.findByRole("menuitem", { name: "Accept change" })).getAttribute("aria-disabled")).toBe("true")
		cleanup()

		renderRibbon()
		tab("Review")
		expect(screen.queryByRole("button", { name: "Markup" })).toBeNull()
	})

	it("zooms, switches Mobile view and field codes from the View tab", () => {
		const { execute, onZoom, onReflowChange } = renderRibbon()

		tab("View")
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
		expect(onZoom).toHaveBeenLastCalledWith("in")
		fireEvent.click(screen.getByRole("button", { name: "Fit to width" }))
		expect(onZoom).toHaveBeenLastCalledWith("fit")
		fireEvent.click(screen.getByRole("button", { name: "Mobile view" }))
		expect(onReflowChange).toHaveBeenLastCalledWith(true)
		fireEvent.click(screen.getByRole("button", { name: "Show field codes" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "view.fieldCodes" })
	})

	it("zooms to 100% and to a step from View ▸ Zoom, with zoom in and out off at the limits", async () => {
		const { onZoom } = renderRibbon({ zoom: 0.5 })

		tab("View")
		fireEvent.click(screen.getByRole("button", { name: "Zoom to 100%" }))
		expect(onZoom).toHaveBeenLastCalledWith(1)
		fireEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Zoom level, 50%" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "200%" }))
		expect(onZoom).toHaveBeenLastCalledWith(2)
		expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(false)
		expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false)
		cleanup()

		renderRibbon({ zoom: 4 })
		tab("View")
		expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false)
		cleanup()

		renderRibbon({ zoom: 0.25 })
		tab("View")
		expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true)
	})

	it("opens the zoom menu from the status bar's percentage, its steps and fit to width", async () => {
		const { onZoom } = renderRibbon({ zoom: 1.25 })
		const status = screen
			.getAllByRole("button", { name: "Zoom level, 125%" })
			.find(button => button.closest("[data-ribbon-group]") === null)

		if (status === undefined) throw new Error("no status zoom")

		fireEvent.click(status)
		expect((await screen.findByRole("menuitemradio", { name: "125%" })).getAttribute("aria-checked")).toBe("true")
		fireEvent.click(screen.getByRole("menuitemradio", { name: "100%" }))
		expect(onZoom).toHaveBeenLastCalledWith(1)
		cleanup()

		const fitted = renderRibbon({ zoom: 1.25, zoomFit: true })

		fireEvent.click(screen.getByRole("button", { name: "Zoom level, 125%" }))
		expect((await screen.findByRole("menuitemradio", { name: "Fit to width" })).getAttribute("aria-checked")).toBe("true")
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Fit to width" }))
		expect(fitted.onZoom).toHaveBeenLastCalledWith("fit")
	})

	it("shows Page X of Y in the status bar and goes to a typed page from Go To (Ctrl+G opens it)", async () => {
		const { pages, onGoTo } = renderRibbon()

		// Nothing laid out yet: no indicator.
		expect(screen.queryByRole("button", { name: /^Page / })).toBeNull()
		act(() => {
			pages.setPage(1, 5)
		})
		expect(screen.getByRole("button", { name: "Page 2 of 5, go to a page" }).textContent).toBe("Page 2 of 5")

		fireEvent.click(screen.getByRole("button", { name: "Page 2 of 5, go to a page" }))

		const field = await screen.findByRole("textbox", { name: "Enter page number" })

		expect(screen.getByRole("button", { name: "Go to" }).hasAttribute("disabled")).toBe(true)
		fireEvent.change(field, { target: { value: "9" } })
		// Past the end: the last page, as Word goes.
		fireEvent.submit(field)
		expect(onGoTo).toHaveBeenLastCalledWith(4)
		expect(pages.get().goTo).toBe(false)

		// Ctrl+G (the editor's onGoTo) opens it without a click.
		act(() => {
			pages.setGoTo(true)
		})
		fireEvent.change(await screen.findByRole("textbox", { name: "Enter page number" }), { target: { value: "3" } })
		fireEvent.click(screen.getByRole("button", { name: "Go to" }))
		expect(onGoTo).toHaveBeenLastCalledWith(2)
		cleanup()

		// Mobile view has no pages.
		const reflowed = renderRibbon({ surface: "reflow" })

		act(() => {
			reflowed.pages.setPage(0, 5)
		})
		expect(screen.queryByRole("button", { name: /^Page / })).toBeNull()
	})

	it("tells the page indicator only of a change (scrolling within a page notifies nothing)", () => {
		const pages = createDocxPageStore()
		const listener = vi.fn()

		pages.subscribe(listener)
		pages.setPage(0, 3)
		pages.setPage(0, 3)
		pages.setGoTo(false)
		expect(listener).toHaveBeenCalledTimes(1)
		pages.setPage(2, 3)
		pages.setGoTo(true)
		expect(listener).toHaveBeenCalledTimes(3)
		expect(pages.get()).toEqual({ page: 2, count: 3, goTo: true })
		expect(goToPageIndex("", 3)).toBeNull()
		expect(goToPageIndex("0", 3)).toBe(0)
	})

	it("runs the table's commands on the Table tab, asks for the split's size, and shows the table's state", async () => {
		const enabled = ribbonSnapshot().enabled
		const { execute, requestInput } = renderRibbon({
			snapshot: { ...ribbonSnapshotIn({ table: TABLE }), enabled: { ...enabled, "table.cells.merge": false } }
		})

		tab("Table")
		fireEvent.click(screen.getByRole("button", { name: "Insert row below" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.row.insertBelow" })
		expect(screen.getByRole("button", { name: "Merge cells" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Header row" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "Split cells…" }))
		expect(requestInput).toHaveBeenLastCalledWith("table.cell.split")
		fireEvent.click(screen.getByRole("button", { name: "Table style" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Grid Table 4" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.style", styleId: "GridTable4" })
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete table" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.delete" })
		fireEvent.click(screen.getByRole("button", { name: "Shading" }))
		expect((await screen.findByRole("button", { name: "Red" })).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "No color" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.cell.shading", fill: null })
	})

	it("shades cells with a theme colour by its reference", async () => {
		const theme = themeSwatches(name => (name === "dark1" || name === "text1" ? "000000" : "4472C4"))
		const tinted = theme[1]?.find(swatch => swatch.key.startsWith("theme:accent1/tint:"))

		if (tinted === undefined) throw new Error("no accent1 tint")

		const { execute } = renderRibbon({ snapshot: ribbonSnapshotIn({ table: { ...TABLE, shading: tinted.key } }), theme })

		tab("Table")
		fireEvent.click(screen.getByRole("button", { name: "Shading" }))

		const pressed = (await screen.findAllByRole("button")).filter(
			button => button.getAttribute("aria-pressed") === "true" && button.closest("[data-ribbon-group]") === null
		)
		const [chosen] = pressed

		if (chosen === undefined || pressed.length !== 1) throw new Error("not one colour marked")

		fireEvent.click(chosen)
		expect(execute).toHaveBeenLastCalledWith({
			type: "table.cell.shading",
			fill: tinted.rgb,
			theme: "accent1",
			tint: tinted.color.kind === "theme" ? tinted.color.tint : undefined
		})
	})

	it("writes nothing from the Table tab while read-only", () => {
		renderRibbon({ snapshot: ribbonSnapshotIn({ table: TABLE }), readOnly: true })
		tab("Table")
		expect(screen.getByRole("button", { name: "Insert row below" }).hasAttribute("disabled")).toBe(true)
	})

	it("offers the Picture tab's tools for the selected picture, without cropping in Mobile view", () => {
		const { execute, requestInput } = renderRibbon({ snapshot: ribbonSnapshotIn({ drawing: PICTURE }) })

		tab("Picture")

		const group = screen.getByRole("group", { name: "Picture" })

		expect(within(group).getByRole("button", { name: "Wrap text" })).toBeTruthy()
		fireEvent.click(within(group).getByRole("button", { name: "Alt text…" }))
		expect(requestInput).toHaveBeenLastCalledWith("drawing.altText")
		fireEvent.click(within(group).getByRole("button", { name: "Delete picture" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "drawing.delete" })
		expect(within(group).getByRole("button", { name: "Crop" })).toBeTruthy()
		cleanup()

		renderRibbon({ snapshot: ribbonSnapshotIn({ drawing: PICTURE }), surface: "reflow", reflow: true })
		tab("Picture")
		expect(screen.queryByRole("button", { name: "Crop" })).toBeNull()
	})

	it("collapses Clipboard and Paragraph into dropdowns on a tablet's row, keeping the font in full", async () => {
		size.width = 1024

		const { execute } = renderRibbon()
		const row = commands()

		expect(within(row).getByRole("group", { name: "Font" })).toBeTruthy()
		expect(within(row).queryByRole("group", { name: "Paragraph" })).toBeNull()
		fireEvent.click(within(row).getByRole("button", { name: "Paragraph" }))
		fireEvent.click(within(await screen.findByRole("toolbar", { name: "Paragraph" })).getByRole("button", { name: "Center" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "align.center" })
		await waitFor(() => {
			expect(screen.queryByRole("toolbar", { name: "Paragraph" })).toBeNull()
		})
	})

	it("keeps undo and the character formats in a phone's row, everything else in the overflow menu", async () => {
		vi.spyOn(window, "matchMedia").mockImplementation(
			query =>
				({
					matches: query.includes("max-width"),
					media: query,
					addEventListener: () => undefined,
					removeEventListener: () => undefined
				}) as unknown as MediaQueryList
		)

		for (const width of [360, 390]) {
			size.width = width

			const { execute } = renderRibbon()
			const row = commands()

			expect(
				within(row)
					.getAllByRole("group")
					.map(group => group.getAttribute("aria-label"))
			).toEqual(["Undo", "Formatting"])
			fireEvent.click(within(row).getByRole("button", { name: "More commands" }))
			fireEvent.click(
				within(await screen.findByRole("toolbar", { name: "Paragraph" })).getByRole("button", { name: "Bulleted list" })
			)
			expect(execute).toHaveBeenLastCalledWith({ type: "list.bullet" })
			cleanup()
		}
	})
})
