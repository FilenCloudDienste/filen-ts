// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DOCX_EDITOR_COMMANDS, NO_REVIEW, NO_VALUES, type DocxEditorSnapshot, type DocxTableContext } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxObjectPress } from "@filen/office/react/docx/editor"
import { slotCommands } from "@/features/preview/components/docxEditor.logic"

// The Table tab's groups and dialogs, and dragging a column border (its direction turned in a
// right-to-left table).

const border = vi.hoisted(() => ({ value: undefined as import("@filen/office/core/docx/paged").DocxTableBorder | undefined }))

vi.mock("@filen/office/core/docx/paged", async () => ({
	...(await vi.importActual<typeof import("@filen/office/core/docx/paged")>("@filen/office/core/docx/paged")),
	tableBorderOf: () => border.value
}))

const { DocxTableSplitDialog, TableAlignment, TableDesign, TableRowsColumns } = await import("@/features/preview/components/docxTableMenu")
const { DocxTableBorderDrag } = await import("@/features/preview/components/docxTableBorderDrag")

const TABLE: DocxTableContext = {
	rows: 2,
	columns: 3,
	fromRow: 0,
	toRow: 1,
	fromColumn: 1,
	toColumn: 2,
	mergeable: false,
	splittable: true,
	headerRow: true,
	styleId: "TableGrid",
	depth: 0,
	widths: [2000, 2000, 2000],
	rtl: false,
	align: "center",
	vAlign: null,
	shading: "FF0000",
	styles: [
		{ id: "TableGrid", name: "Table Grid" },
		{ id: "GridTable4", name: "Grid Table 4" }
	]
}

function snapshot(table: DocxTableContext | null, enabled: Partial<DocxEditorSnapshot["enabled"]> = {}): DocxEditorSnapshot {
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
			table,
			drawing: null,
			control: null,
			field: null,
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

// The Table tab's groups, as the ribbon places them.
function renderGroups(state: DocxEditorSnapshot, readOnly = false) {
	const execute = vi.fn()
	const props = {
		commands: slotCommands("table"),
		snapshot: state,
		readOnly,
		apple: false,
		execute,
		surface: "pages" as const,
		theme: [],
		inputRequest: null,
		requestInput: vi.fn(),
		onInputDone: vi.fn()
	}

	render(
		<>
			<TableRowsColumns {...props} />
			<TableDesign {...props} />
			<TableAlignment {...props} />
		</>
	)

	return { execute }
}

afterEach(() => {
	cleanup()
	border.value = undefined
})

describe("the Table tab's groups", () => {
	it("switch the header row and set the table's and the cells' alignment, as the table has them", async () => {
		const { execute } = renderGroups(snapshot(TABLE))

		expect(screen.getByRole("button", { name: "Header row" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: "Header row" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.row.header" })
		fireEvent.click(screen.getByRole("button", { name: "Table alignment" }))
		expect((await screen.findByRole("menuitemradio", { name: "Center" })).getAttribute("aria-checked")).toBe("true")
		fireEvent.click(screen.getByRole("menuitemradio", { name: "End" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.align", align: "end" })
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})
		fireEvent.click(screen.getByRole("button", { name: "Cell alignment" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Bottom" }))
		expect(execute).toHaveBeenLastCalledWith({ type: "table.cell.vAlign", align: "bottom" })
	})

	it("show nothing outside a table, and nothing that writes while read-only", () => {
		renderGroups(snapshot(null))
		expect(screen.queryByRole("button", { name: "Header row" })).toBeNull()
		cleanup()

		renderGroups(snapshot(TABLE), true)
		expect(screen.getByRole("button", { name: "Insert row above" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Header row" }).hasAttribute("disabled")).toBe(true)
	})
})

describe("DocxTableSplitDialog", () => {
	it("splits the cell into the rows and columns typed", () => {
		const execute = vi.fn(() => true)
		const onInputDone = vi.fn()

		render(
			<DocxTableSplitDialog
				editor={{ execute } as unknown as PagedEditor}
				readOnly={false}
				inputRequest={{ type: "table.cell.split", nonce: 7 }}
				requestInput={vi.fn()}
				onInputDone={onInputDone}
			/>
		)

		fireEvent.change(screen.getByRole("textbox", { name: "Rows" }), { target: { value: "2" } })
		fireEvent.change(screen.getByRole("textbox", { name: "Columns" }), { target: { value: "70" } })
		expect(screen.getByRole("button", { name: "Split" }).hasAttribute("disabled")).toBe(true)
		fireEvent.change(screen.getByRole("textbox", { name: "Columns" }), { target: { value: "3" } })
		fireEvent.click(screen.getByRole("button", { name: "Split" }))
		expect(execute).toHaveBeenCalledWith({ type: "table.cell.split", rows: 2, cols: 3 })
		expect(onInputDone).toHaveBeenCalledWith(7)
	})
})

describe("DocxTableBorderDrag", () => {
	function drag(rtl: boolean, dx: number, zoom: number) {
		border.value = { column: 1, widths: [2000, 2000, 2000], rtl, minTwips: 100 }

		const execute = vi.fn()
		const onPressDone = vi.fn()
		const editor = { hitTest: vi.fn(() => ({ pos: 12, affinity: 1, page: 0, line: 3, atom: false })), select: vi.fn() }
		const press: DocxObjectPress = {
			hit: { kind: "tableBorder", story: 0, pos: 10, part: "column:1" },
			page: 0,
			x: 300,
			y: 200,
			clientX: 500,
			clientY: 300,
			pointerType: "mouse",
			pointerId: 1,
			clicks: 1,
			shiftKey: false
		}
		const container = document.createElement("div")

		document.body.append(container)
		render(
			<DocxTableBorderDrag
				editor={editor as unknown as PagedEditor}
				press={press}
				onPressDone={onPressDone}
				container={container}
				zoom={zoom}
				readOnly={false}
				execute={execute}
			/>
		)

		act(() => {
			window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 500 + dx / 2 }))
		})
		expect(screen.getByRole("separator", { name: "New column border" })).toBeTruthy()
		act(() => {
			window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 500 + dx }))
		})

		return { execute, onPressDone, editor }
	}

	it("widens the column by the drag in a left-to-right table, the caret first in the table", () => {
		const { execute, onPressDone, editor } = drag(false, 20, 1)

		expect(editor.hitTest).toHaveBeenCalledWith(0, 300, 200)
		expect(editor.select).toHaveBeenCalledTimes(1)
		expect(execute).toHaveBeenCalledWith({ type: "table.column.width", index: 1, twips: 2300 })
		expect(onPressDone).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole("separator")).toBeNull()
	})

	it("narrows the column by a drag to the right in a right-to-left table, at the zoom's scale", () => {
		expect(drag(true, 20, 2).execute).toHaveBeenCalledWith({ type: "table.column.width", index: 1, twips: 1850 })
	})

	it("changes nothing for a press that is no draggable border, or a drag Esc cancels", () => {
		const execute = vi.fn()
		const onPressDone = vi.fn()

		render(
			<DocxTableBorderDrag
				editor={{} as PagedEditor}
				press={{
					hit: { kind: "tableBorder", story: 0, pos: 10 },
					page: 0,
					x: 0,
					y: 0,
					clientX: 0,
					clientY: 0,
					pointerType: "mouse",
					pointerId: 1,
					clicks: 1,
					shiftKey: false
				}}
				onPressDone={onPressDone}
				container={null}
				zoom={1}
				readOnly={false}
				execute={execute}
			/>
		)
		expect(onPressDone).toHaveBeenCalledTimes(1)
		cleanup()

		border.value = { column: 0, widths: [2000, 2000], rtl: false, minTwips: 100 }

		const cancelled = vi.fn()
		const container = document.createElement("div")

		render(
			<DocxTableBorderDrag
				editor={{} as PagedEditor}
				press={{
					hit: { kind: "tableBorder", story: 0, pos: 10 },
					page: 0,
					x: 0,
					y: 0,
					clientX: 100,
					clientY: 0,
					pointerType: "mouse",
					pointerId: 2,
					clicks: 1,
					shiftKey: false
				}}
				onPressDone={cancelled}
				container={container}
				zoom={1}
				readOnly={false}
				execute={execute}
			/>
		)
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
			window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 200 }))
		})
		expect(execute).not.toHaveBeenCalled()
		expect(cancelled).toHaveBeenCalledTimes(1)
	})
})

describe("the table dialogs' shared parts", () => {
	it("keeps a rows × columns dialog to Word's table limits", async () => {
		const { DocxRowsColumnsDialog } = await import("@/features/preview/components/docxFields")
		const { TABLE_LIMITS } = await import("@/features/preview/components/docxEditor.logic")
		const onSubmit = vi.fn(() => true)

		render(
			<DocxRowsColumnsDialog
				title="Size"
				description="Rows and columns"
				submitLabel="Go"
				initial={{ rows: 2, cols: 2 }}
				onSubmit={onSubmit}
				onClose={vi.fn()}
			/>
		)
		fireEvent.change(screen.getByRole("textbox", { name: "Columns" }), { target: { value: String(TABLE_LIMITS.columns + 1) } })
		expect(screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")).toBe(true)
		fireEvent.change(screen.getByRole("textbox", { name: "Columns" }), { target: { value: String(TABLE_LIMITS.columns) } })
		fireEvent.change(screen.getByRole("textbox", { name: "Rows" }), { target: { value: String(TABLE_LIMITS.rows) } })
		fireEvent.click(screen.getByRole("button", { name: "Go" }))
		expect(onSubmit).toHaveBeenCalledWith({ rows: 32_767, cols: 63 })
	})
})

describe("DocxTableBorderDrag while rendering", () => {
	it("tells a press on no draggable border done after rendering, never while its parent renders", async () => {
		const { useState } = await import("react")
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const press: DocxObjectPress = {
			hit: { kind: "tableBorder", story: 0, pos: 10 },
			page: 0,
			x: 0,
			y: 0,
			clientX: 0,
			clientY: 0,
			pointerType: "mouse",
			pointerId: 1,
			clicks: 1,
			shiftKey: false
		}

		function Host() {
			const [current, setCurrent] = useState<DocxObjectPress | null>(press)

			return (
				<>
					<output>{current === null ? "done" : "pressed"}</output>
					<DocxTableBorderDrag
						editor={{} as PagedEditor}
						press={current}
						onPressDone={() => {
							setCurrent(null)
						}}
						container={null}
						zoom={1}
						readOnly={false}
						execute={vi.fn()}
					/>
				</>
			)
		}

		render(<Host />)
		expect(await screen.findByText("done")).toBeTruthy()
		expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Cannot update a component/)
	})
})
