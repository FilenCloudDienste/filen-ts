// @vitest-environment happy-dom

import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
	DOCX_EDITOR_COMMANDS,
	NO_REVIEW,
	NO_VALUES,
	datePictures,
	parseDocxEditorCommand,
	type DocxEditorSnapshot,
	type DocxFieldContext
} from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import { slotCommands, type DocxInputRequest } from "@/features/preview/components/docxEditor.logic"
import { fieldChipAction, linkTarget } from "@/features/preview/components/docxInsert.logic"
import type { DocxCommandProps } from "@/features/preview/components/docxRibbon.logic"
import "@/lib/i18n"

// The ribbon's Insert, Layout and References dropdowns (their items run commands or ask for their input) and the
// dialogs they ask: a link (to an
// address, a heading by its position, editing one preselecting it), a date previewed, bookmarks, a table's size.

const paged = vi.hoisted(() => ({
	outline: [] as { level: number; text: string; pos: number }[],
	bookmarks: [] as { name: string; from: number }[],
	hidden: new Map<string, { hidden: boolean; start: string; startPos: number }>()
}))

vi.mock("@filen/office/core/docx/paged", async () => ({
	...(await vi.importActual<typeof import("@filen/office/core/docx/paged")>("@filen/office/core/docx/paged")),
	docxOutline: () => ({ doc: null, entries: paged.outline }),
	docxBookmarks: () => paged.bookmarks,
	goToOutlineEntry: () => true
}))
vi.mock("@filen/office/core/docx/edit", async () => ({
	...(await vi.importActual<typeof import("@filen/office/core/docx/edit")>("@filen/office/core/docx/edit")),
	sessionBookmarks: () => ({ byName: paged.hidden })
}))

const { ConvertNotesMenu, DocxBreaksMenu, FormControlMenu, PicturesMenu, TableMenu } =
	await import("@/features/preview/components/docxInsertMenu")
const { DocxInsertDialogs } = await import("@/features/preview/components/docxInsertDialogs")

function snapshot(enabled: Partial<DocxEditorSnapshot["enabled"]> = {}, field: DocxFieldContext | null = null): DocxEditorSnapshot {
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
			drawing: null,
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

function renderMenu(Menu: ComponentType<DocxCommandProps>, commands = slotCommands("insert"), readOnly = false) {
	const execute = vi.fn()
	const requestInput = vi.fn()

	render(
		<Menu
			commands={commands}
			snapshot={snapshot()}
			readOnly={readOnly}
			execute={execute}
			requestInput={requestInput}
		/>
	)

	return { execute, requestInput }
}

function fakeEditor(): PagedEditor {
	return {
		activeStory: 0,
		body: { session: { story: { story: { index: 0 } }, state: { doc: { resolve: (pos: number) => ({ before: () => pos - 1 }) } } } },
		selection: () => ({ from: 3, to: 3, anchor: 3, head: 3, empty: true, node: false }),
		// The caret's language: none set (the date dialog then offers Word's English (United States) formats).
		session: { state: { storedMarks: null, selection: { $from: { parent: { isTextblock: false } } } } },
		select: vi.fn(),
		exitStory: vi.fn()
	} as unknown as PagedEditor
}

function renderDialog(type: DocxInputRequest["type"], state = snapshot()) {
	const execute = vi.fn()
	const onDone = vi.fn()

	render(
		<DocxInsertDialogs
			request={{ type, nonce: 4 }}
			editor={fakeEditor()}
			snapshot={state}
			readOnly={false}
			execute={execute}
			onDone={onDone}
		/>
	)

	return { execute, onDone }
}

// Picks an option of a select the way a pointer does.
async function choose(label: string, option: string): Promise<void> {
	const trigger = screen.getByLabelText(label)

	fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(trigger, { button: 0 })
	fireEvent.click(trigger)

	const item = await screen.findByRole("option", { name: option })

	fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(item, { button: 0 })
	fireEvent.click(item)
}

afterEach(() => {
	cleanup()
	paged.outline = []
	paged.bookmarks = []
	paged.hidden.clear()
})

describe("the Insert, Layout and References dropdowns", () => {
	it("inserts a table of the size picked on its grid, or asks for its size", async () => {
		const { execute, requestInput } = renderMenu(TableMenu)

		fireEvent.click(screen.getByRole("button", { name: "Table" }))
		fireEvent.click(await screen.findByRole("button", { name: "3 × 2 table" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.insert", cols: 3, rows: 2 })

		fireEvent.click(screen.getByRole("button", { name: "Table" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Insert table…" }))
		expect(requestInput).toHaveBeenLastCalledWith("table.insert")
	})

	it("breaks the page, the line or the section of the kind picked", async () => {
		const { execute } = renderMenu(DocxBreaksMenu, [...slotCommands("insert"), ...slotCommands("layout")])

		fireEvent.click(screen.getByRole("button", { name: "Breaks" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Page break" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "insert.pageBreak" })

		fireEvent.click(screen.getByRole("button", { name: "Breaks" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Next page" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "insert.sectionBreak", kind: "nextPage" })
	})

	it("leaves the focus in the document after a command (the host gives it back)", async () => {
		const area = document.createElement("textarea")

		document.body.append(area)
		area.focus()

		const { execute } = renderMenu(ConvertNotesMenu, slotCommands("references"))

		execute.mockImplementation(() => {
			area.focus()
		})
		fireEvent.click(screen.getByRole("button", { name: "Convert all notes" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Convert all to endnotes" }))
		expect(execute).toHaveBeenCalledWith({ type: "note.convertAll", to: "endnote" })
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})
		expect(document.activeElement).toBe(area)
		area.remove()
	})

	it("offers nothing that writes while read-only", () => {
		renderMenu(PicturesMenu, slotCommands("insert"), true)

		expect(screen.getByRole("button", { name: "Picture" }).hasAttribute("disabled")).toBe(true)
		cleanup()
		renderMenu(FormControlMenu, slotCommands("insert"), true)
		expect(screen.getByRole("button", { name: "Form control" }).hasAttribute("disabled")).toBe(true)
	})
})

describe("DocxInsertDialogs", () => {
	it("links the selection to a typed address, adding the scheme", () => {
		const { execute, onDone } = renderDialog("link.set")

		fireEvent.change(screen.getByLabelText("Text to display"), { target: { value: "Example" } })
		fireEvent.change(screen.getByLabelText("Address"), { target: { value: "example.com" } })
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))

		expect(execute).toHaveBeenCalledWith({ type: "link.set", target: "https://example.com", text: "Example" })
		expect(onDone).toHaveBeenCalledWith(4)
	})

	it("links new addresses to the web, email or a phone only, and edits a link's text without its target", () => {
		const { execute } = renderDialog("link.set")
		const insert = screen.getByRole("button", { name: "Insert" })
		const address = screen.getByLabelText("Address")

		for (const typed of ["ftp://files.example.com", "sms:123", "C:\\Reports\\a.docx"]) {
			fireEvent.change(address, { target: { value: typed } })
			expect(screen.getByRole("alert").textContent).toBe(
				"Links can go to web (http, https), email (mailto) and phone (tel) addresses only."
			)
			expect(address.getAttribute("aria-invalid")).toBe("true")
			expect(insert.hasAttribute("disabled") || insert.getAttribute("aria-disabled") === "true").toBe(true)
		}

		fireEvent.change(address, { target: { value: "tel:+491234" } })
		expect(screen.queryByRole("alert")).toBeNull()
		fireEvent.click(insert)
		expect(execute).toHaveBeenCalledWith({ type: "link.set", target: "tel:+491234" })
		cleanup()

		const state = snapshot()
		const edited = renderDialog("link.set", {
			...state,
			context: { ...state.context, link: { target: "file:///C:/a.docx", anchor: null, text: "local file" } }
		})

		expect(screen.queryByRole("alert")).toBeNull()
		fireEvent.change(screen.getByLabelText("Text to display"), { target: { value: "the file" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(edited.execute).toHaveBeenCalledWith({ type: "link.set", target: "file:///C:/a.docx", text: "the file" })
	})

	it("links to a heading by its position (the core makes or reuses its hidden bookmark); empty ones are not offered", async () => {
		paged.outline = [
			{ level: 0, text: " ", pos: 4 },
			{ level: 0, text: "Über uns", pos: 10 }
		]

		const { execute } = renderDialog("link.set")

		await choose("Link to", "Place in this document")
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))

		expect(execute.mock.calls).toEqual([[{ type: "link.set", heading: 10 }]])
	})

	it("edits a link to a heading with that heading picked", () => {
		paged.outline = [
			{ level: 0, text: "Intro", pos: 2 },
			{ level: 0, text: "Results", pos: 10 }
		]
		paged.hidden.set("_toc123456789", { hidden: true, start: "inline", startPos: 11 })

		const state = snapshot()
		const { execute } = renderDialog("link.set", {
			...state,
			context: { ...state.context, link: { target: null, anchor: "_Toc123456789", text: "Results" } }
		})

		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(execute).toHaveBeenCalledWith({ type: "link.set", heading: 10, text: "Results" })
	})

	it("inserts a date as text in the format picked, previewed, or a field that updates automatically", () => {
		const { execute } = renderDialog("insert.date")

		expect(screen.getAllByRole("radio").length).toBeGreaterThan(10)
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))
		expect(execute).toHaveBeenCalledWith({ type: "insert.date", format: "M/d/yyyy", field: false })
		cleanup()

		const field = renderDialog("insert.date")

		fireEvent.click(screen.getByRole("switch", { name: "Update automatically" }))
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))
		expect(field.execute).toHaveBeenCalledWith({ type: "insert.date", format: "M/d/yyyy", field: true })
	})

	it("adds a bookmark with a valid name and explains an invalid one", () => {
		paged.bookmarks = [{ name: "Intro", from: 2 }]

		const { execute } = renderDialog("bookmark.add")

		fireEvent.change(screen.getByLabelText("Bookmark name"), { target: { value: "intro" } })
		expect(screen.getByText("A bookmark with this name already exists.")).toBeTruthy()
		fireEvent.change(screen.getByLabelText("Bookmark name"), { target: { value: "1st" } })
		expect(screen.getByText(/starts with a letter/)).toBeTruthy()
		fireEvent.change(screen.getByLabelText("Bookmark name"), { target: { value: "Summary" } })
		// Enter adds, as the Add button does.
		fireEvent.submit(screen.getByLabelText("Bookmark name"))
		expect(execute).toHaveBeenCalledWith({ type: "bookmark.add", name: "Summary" })
		fireEvent.change(screen.getByLabelText("Bookmark name"), { target: { value: "Closing" } })
		fireEvent.click(screen.getByRole("button", { name: "Add" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "bookmark.add", name: "Closing" })

		fireEvent.click(screen.getByRole("button", { name: "Intro" }))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "bookmark.delete", name: "Intro" })
	})

	it("inserts a table of the size typed", () => {
		const { execute } = renderDialog("table.insert")

		fireEvent.change(screen.getByLabelText("Columns"), { target: { value: "4" } })
		fireEvent.click(screen.getByRole("button", { name: "Insert" }))
		expect(execute).toHaveBeenCalledWith({ type: "table.insert", rows: 2, cols: 4 })
	})
})

describe("insert logic", () => {
	it("reads typed link addresses as Word does", () => {
		expect(linkTarget("example.com/a")).toBe("https://example.com/a")
		expect(linkTarget("http://example.com")).toBe("http://example.com")
		expect(linkTarget("me@example.com")).toBe("mailto:me@example.com")
		// "host:port" is no scheme.
		expect(linkTarget("example.com:8080/a")).toBe("https://example.com:8080/a")
		expect(linkTarget("localhost:3000")).toBe("https://localhost:3000")
		expect(linkTarget("ftp://files.example.com")).toBe("ftp://files.example.com")
		expect(linkTarget("tel:+491234")).toBe("tel:+491234")
		// A Windows path is a file link (never https://C:...).
		// As Word writes it: backslashes kept, only spaces and non-ASCII percent-encoded.
		expect(linkTarget("C:\\Reports\\Q3 plan.docx")).toBe("file:///C:\\Reports\\Q3%20plan.docx")
		expect(linkTarget("C:\\a\\Q#1 50% é.docx")).toBe("file:///C:\\a\\Q#1%2050%%20%C3%A9.docx")
		expect(linkTarget("\\\\server\\share\\a.pdf")).toBe("file://server/share/a.pdf")
		expect(linkTarget("  ")).toBeNull()
		expect(linkTarget("two words")).toBeNull()
	})

	it("offers the caret language's date formats: Word's for English (United States), the language's own else", () => {
		expect(datePictures(undefined)[0]).toBe("M/d/yyyy")
		expect(datePictures("en-US")).toContain("dddd, MMMM d, yyyy")

		const german = datePictures("de-DE")

		// The numeric short date with a four-digit year first.
		expect(german[0]).toBe("dd.MM.yyyy")
		expect(german).toContain("d. MMMM yyyy")
		expect(german).toContain("yyyy-MM-dd")
		expect(german).not.toContain("M/d/yyyy")

		for (const picture of [...german, ...datePictures("fr-FR"), ...datePictures("ja-JP")]) {
			expect(parseDocxEditorCommand({ type: "insert.date", format: picture }), picture).toBeDefined()
		}
	})

	it("offers the chip's action only while its command is enabled", () => {
		const field: DocxFieldContext = { type: "PAGE", updatable: true, toc: false, instruction: " PAGE ", refusal: null }
		const toc: DocxFieldContext = { type: "TOC", updatable: true, toc: true, instruction: " TOC ", refusal: null }
		const press = (kind: "field" | "noteRef", part?: string): DocxObjectPress => ({
			hit: { kind, story: 0, pos: 4, ...(part === undefined ? {} : { part }) },
			page: 0,
			x: 0,
			y: 0,
			clientX: 0,
			clientY: 0,
			pointerType: "mouse",
			pointerId: 1,
			clicks: 1,
			shiftKey: false
		})

		expect(fieldChipAction(press("field"), snapshot({}, field), false)).toBe("field")
		expect(fieldChipAction(press("field"), snapshot({ "field.update": false }, field), false)).toBeNull()
		expect(fieldChipAction(press("field", "toc"), snapshot({}, toc), false)).toBe("toc")
		expect(fieldChipAction(press("field", "toc"), snapshot({ "toc.update": false }, toc), false)).toBeNull()
		expect(fieldChipAction(press("field"), snapshot({}, field), true)).toBeNull()
		expect(fieldChipAction(press("noteRef"), snapshot(), false)).toBe("note")
		expect(fieldChipAction(null, snapshot(), false)).toBeNull()
	})
})
