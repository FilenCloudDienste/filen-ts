// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { menuGroups, rendersItems } from "@/features/spreadsheet/components/sheetExtension"
import { registerAllActions } from "@/lib/keymap/actions"
import { file, sheetBytes, stubSheetCanvas } from "@/tests/support/sheetViewerHarness"

// The grid's menu puts a separator only between groups that show something: none first, last or twice in a row,
// also when a feature's group comes out empty (a read-only file, a cell with nothing to offer).

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>())
)

vi.mock("@/features/preview/hooks/usePreviewBytes", async () => (await import("@/tests/support/sheetViewerHarness")).previewBytesMock())

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>())
)

const { SheetViewer } = await import("@/features/spreadsheet/sheetViewer")

registerAllActions()

beforeEach(stubSheetCanvas)

describe("the grid menu's separators", () => {
	it("leaves out a group whose parts all came out empty", () => {
		expect(rendersItems(null)).toBe(false)
		expect(
			rendersItems(
				<>
					{false}
					{null}
					<>{undefined}</>
				</>
			)
		).toBe(false)
		expect(rendersItems(<>{[null, <span key="a">a</span>]}</>)).toBe(true)
		expect(
			menuGroups([{ id: "empty", menuItems: <>{null}</> }, { id: "none" }, { id: "item", menuItems: <span>a</span> }]).map(
				group => group.id
			)
		).toEqual(["item"])
	})

	it("starts, ends and runs without a separator on a read-only file", async () => {
		sheetBytes.current = await writeXlsx({ sheets: [{ name: "One", rows: [["a", "b"]] }] })
		render(
			<SheetViewer
				item={file("ro.xlsx")}
				documentKey="ro"
				alt="ro.xlsx"
				editable={false}
				saveRef={{ current: null }}
			/>
		)

		const grid = await screen.findByRole("grid", {}, { timeout: 5000 })

		await act(async () => {
			fireEvent.contextMenu(grid, { clientX: 100, clientY: 60 })
			await new Promise(resolve => setTimeout(resolve, 100))
		})

		const menu = await screen.findByRole("menu", {}, { timeout: 3000 })
		const kinds = [...menu.children].map(child => (child.getAttribute("role") === "separator" ? "|" : "item")).join(" ")

		expect(kinds).toContain("item")
		expect(kinds).not.toMatch(/\| \||^\||\|$/)
	})
})
