// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { gridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import type { SheetView } from "@/features/spreadsheet/lib/model"

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
	)
})

function sheet(extra: Partial<SheetView> = {}): SheetView {
	return {
		name: "Sheet1",
		rowCount: 5,
		colCount: 3,
		cells: new Map(),
		merges: [],
		colWidths: new Map(),
		rowHeights: new Map(),
		hiddenCols: [],
		hiddenRows: [],
		frozenRows: 1,
		frozenCols: 1,
		structureLocked: false,
		...extra
	}
}

// The rail cells' tint is a translucent token (bg-muted / bg-accent): the sticky layer holding them must
// be opaque, or cells scrolled under the rail show through.
describe("SheetGrid header rails", () => {
	it("paints every rail layer, frozen ones included, over an opaque background", () => {
		const { container } = render(
			<SheetGrid
				sheet={gridSheet(sheet())}
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
})
