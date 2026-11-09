// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { useMoveReplace } from "@/features/spreadsheet/components/moveReplaceDialog"
import { refusalKey } from "@/features/spreadsheet/lib/sheetMessages.logic"

// Excel's question when cells dragged by the selection's border land on data: its wording, OK replacing, Cancel
// leaving the cells as they were.

afterEach(() => {
	cleanup()
})

// A drop the grid would report: the button stands for it.
function Host({ replace }: { replace: () => void }) {
	const moveReplace = useMoveReplace()

	return (
		<>
			<button
				type="button"
				onClick={() => {
					moveReplace.ask(replace)
				}}
			>
				drop
			</button>
			{moveReplace.dialog}
		</>
	)
}

describe("the replace question of a cell drag", () => {
	it("asks in Excel's words and replaces on OK", () => {
		const replace = vi.fn()

		render(<Host replace={replace} />)
		fireEvent.click(screen.getByRole("button", { name: "drop" }))
		expect(screen.getByText(preview.previewSheetMoveReplaceBody)).toBeTruthy()
		expect(preview.previewSheetMoveReplaceBody).toBe("There's already data here. Do you want to replace it?")
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetMoveReplaceConfirm }))
		expect(replace).toHaveBeenCalledTimes(1)
	})

	it("leaves the cells on Cancel", () => {
		const replace = vi.fn()

		render(<Host replace={replace} />)
		fireEvent.click(screen.getByRole("button", { name: "drop" }))
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(replace).not.toHaveBeenCalled()
	})

	it("says the question as a refusal where the grid has no one to ask", () => {
		expect(refusalKey({ reason: "occupied" }, "xlsx")).toBe("previewSheetMoveReplaceBody")
	})
})
