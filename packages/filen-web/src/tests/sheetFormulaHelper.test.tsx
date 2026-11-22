// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetGridModel } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { assistant } from "@/locales/en/assistant"
import { registerAssistantFormulaWriter } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantFormulaOutcome, AssistantFormulaRequest } from "@/features/assistant/types"
import { FormulaHelper } from "@/features/spreadsheet/formulaBar/formulaHelper"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"

// The formula bar's ✨: the request describes the cells around the selection, the written formula goes through the
// sheet's real check and engine (formulaPreview on a formula-free workbook), the result is the engine's, and Insert
// starts the entry for the user to confirm.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }

// What the fake model writes, first attempt then second; the real check decides, as the shared loop would.
let written: string[] = []
let seen: AssistantFormulaRequest | null = null
let unregister: () => void

async function fakeRun(request: AssistantFormulaRequest): Promise<AssistantFormulaOutcome> {
	seen = request

	for (const formula of written) {
		const checked = await request.check(formula)

		if (checked.ok) return { ok: true, formula, value: checked.value }
	}

	return { ok: false, error: "invalid" }
}

beforeEach(() => {
	written = []
	seen = null
	unregister = registerAssistantFormulaWriter({ run: fakeRun, shutdown: () => undefined })
	useAssistantStore.setState({ modelState: { kind: "ready", model: MODEL } })
})

afterEach(() => {
	unregister()
	cleanup()
})

async function mount(): Promise<SheetGridModel> {
	const model = await openGrid(
		await workbook([
			{
				name: "Sales",
				rows: [
					["Region", "Amount"],
					["north", 10],
					["south", 20],
					["north", 5]
				]
			}
		]),
		"xlsx"
	)

	await model.intent()
	act(() => {
		model.choose({
			active: { row: 4, col: 1 },
			anchor: { row: 4, col: 1 },
			focus: { row: 4, col: 1 },
			ranges: [{ startRow: 4, startCol: 1, endRow: 4, endCol: 1 }]
		})
	})
	render(<GridHarness model={model}>{grid => <FormulaHelper grid={grid} />}</GridHarness>)

	return model
}

async function ask(text: string): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: assistant.assistantFormulaOpen }))
	fireEvent.change(await screen.findByRole("textbox", { name: assistant.assistantFormulaAskLabel }), { target: { value: text } })
	fireEvent.click(screen.getByRole("button", { name: assistant.assistantFormulaWrite }))
}

describe("the formula helper", () => {
	it("describes the data around the active cell and shows the engine's result", async () => {
		const model = await mount()

		written = ['=SUMIF(A2:A4,"north",B2:B4)']
		await ask("total for north")

		expect(await screen.findByText("Result for B5: 15")).toBeTruthy()
		expect(seen?.context).toMatchObject({
			sheet: "Sales",
			range: "A1:B5",
			headerRow: 1,
			cell: "B5",
			columns: [
				{ column: "A", header: "Region", types: ["text", "text", "text"] },
				{ column: "B", header: "Amount", types: ["number", "number", "number"] }
			],
			ask: "total for north"
		})

		fireEvent.click(screen.getByRole("button", { name: assistant.assistantFormulaInsert }))

		expect(model.getSnapshot().editing?.text).toBe('=SUMIF(A2:A4,"north",B2:B4)')
		expect(model.getSnapshot().selection.active).toEqual({ row: 4, col: 1 })
	})

	it("says a refused formula is not valid and offers Try again", async () => {
		await mount()

		written = ["=SUM(B:B)", '=HYPERLINK("https://example.com")']
		await ask("sum the amounts")

		expect(await screen.findByText(assistant.assistantFormulaInvalid)).toBeTruthy()
		expect(screen.getByRole("button", { name: assistant.assistantTransformTryAgain })).toBeTruthy()
		expect(screen.queryByRole("button", { name: assistant.assistantFormulaInsert })).toBeNull()
	})

	it("is not offered where the model can never run", async () => {
		useAssistantStore.setState({ modelState: { kind: "unavailable", reason: "unsupported-browser", model: null } })
		await mount()

		expect(screen.queryByRole("button", { name: assistant.assistantFormulaOpen })).toBeNull()
	})
})
