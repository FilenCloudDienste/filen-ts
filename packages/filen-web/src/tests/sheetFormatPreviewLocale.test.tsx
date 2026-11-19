// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { TooltipProvider } from "@/components/ui/tooltip"
import { setRegionalFormat } from "@/features/office/lib/regionalFormat"
import { FormatCellsDialog } from "@/features/spreadsheet/dialogs/formatCells"
import { NumberFormatMenu } from "@/features/spreadsheet/toolbar/numberFormatMenu"

// The Format Cells dialog and the Number Format menu preview a value in the regional format the grid shows cells in,
// not in en-US, and follow a change of it.

// 2012-03-14 (1900 date system).
const MARCH_14_2012 = 40982

function renderDialog(numFmt: string, sample: number | null): void {
	render(
		<FormatCellsDialog
			open
			numFmt={numFmt}
			sample={sample}
			date1904={false}
			onOpenChange={() => undefined}
			onApply={() => undefined}
		/>
	)
}

afterEach(() => {
	setRegionalFormat(null)
})

describe("format previews in the regional format", () => {
	it("shows the Format Cells sample with the regional separators", () => {
		setRegionalFormat("de-DE")
		renderDialog("#,##0.00", null)

		expect(document.getElementById("format-cells-sample")?.textContent).toBe("1.234,50")
	})

	it("lists the date types with the regional names and patterns", () => {
		setRegionalFormat("de-DE")
		renderDialog("[$-F800]dddd, mmmm dd, yyyy", MARCH_14_2012)

		expect(document.getElementById("format-cells-sample")?.textContent).toBe("Mittwoch, 14. März 2012")
		expect(document.getElementById("format-cells-type")?.textContent).toContain("Mittwoch, 14. März 2012")
	})

	it("follows a change of the regional format while open", () => {
		setRegionalFormat("de-DE")
		renderDialog("#,##0.00", null)

		act(() => {
			setRegionalFormat("en-US")
		})

		expect(document.getElementById("format-cells-sample")?.textContent).toBe("1,234.50")
	})

	it("shows the Number Format menu's samples with the regional separators", async () => {
		setRegionalFormat("de-DE")
		render(
			<TooltipProvider>
				<NumberFormatMenu
					numFmt="General"
					sample={1234.5}
					date1904={false}
					disabled={false}
					onFormat={() => undefined}
					onMore={() => undefined}
				/>
			</TooltipProvider>
		)

		fireEvent.click(screen.getByRole("button"))

		// The Number item's code is 0.00.
		expect(await screen.findByText("1234,50")).toBeTruthy()
	})
})
