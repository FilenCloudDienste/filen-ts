// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { gridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import { mockSheetView } from "@/tests/mockSheetView"

// The rail cells' tint is a translucent token (bg-muted / bg-accent): the sticky layer holding them must
// be opaque, or cells scrolled under the rail show through.
describe("SheetGrid header rails", () => {
	it("paints every rail layer, frozen ones included, over an opaque background", () => {
		const { container } = render(
			<SheetGrid
				sheet={gridSheet(mockSheetView({ colCount: 3, frozenRows: 1, frozenCols: 1 }))}
				styles={[]}
				selection={{ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }}
				onSelectionChange={() => undefined}
				label="test.xlsx"
			/>
		)
		const rails = [...container.querySelectorAll('[role="columnheader"], [role="rowheader"]')].map(header => header.closest(".sticky"))

		expect(rails.length).toBeGreaterThan(0)

		for (const rail of rails) {
			expect(rail?.classList.contains("bg-background")).toBe(true)
		}
	})

	it("paints the select-all corner opaque too", () => {
		const { container } = render(
			<SheetGrid
				sheet={gridSheet(mockSheetView({ colCount: 3, frozenRows: 1, frozenCols: 1 }))}
				styles={[]}
				selection={{ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }}
				onSelectionChange={() => undefined}
				label="test.xlsx"
			/>
		)

		expect(container.querySelector(".grid > .sticky.top-0.left-0")?.classList.contains("bg-background")).toBe(true)
	})
})
