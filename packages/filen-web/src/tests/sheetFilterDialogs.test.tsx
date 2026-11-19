// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetCommand, SheetFilterCriteria } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { FilterConditionDialog, FilterTop10Dialog } from "@/features/spreadsheet/data/filterDialogs"
import type { DialogOperator, FilterKind } from "@/features/spreadsheet/data/sortFilter.logic"

// The autofilter's Custom filter and Top 10 dialogs: the closed selects show their option's text, each control has its
// own name, the criteria sent per condition and join, a value that does not read as a number, Top 10's bounds, and
// stored criteria read back into both rows.

afterEach(() => {
	cleanup()
})

// The dialogs read the shown sheet and close through the sort and filter store, keyed by the model.
function fakeModel(): SheetGridModel {
	return { getSnapshot: () => ({ sheet: 3 }) } as unknown as SheetGridModel
}

function renderCondition({
	kind = "text",
	first = "equals",
	second,
	criteria = null
}: {
	kind?: FilterKind
	first?: DialogOperator
	second?: DialogOperator
	criteria?: SheetFilterCriteria | null
}) {
	const run = vi.fn<(command: SheetCommand) => void>()

	render(
		<FilterConditionDialog
			model={fakeModel()}
			open={{
				type: "condition",
				row: 0,
				col: 2,
				header: "Amount",
				kind,
				first,
				...(second !== undefined && { second }),
				criteria
			}}
			date1904={false}
			run={run}
		/>
	)

	return run
}

function renderTop10(criteria: SheetFilterCriteria | null = null) {
	const run = vi.fn<(command: SheetCommand) => void>()

	render(
		<FilterTop10Dialog
			model={fakeModel()}
			open={{ type: "top10", row: 0, col: 2, header: "Amount", criteria }}
			run={run}
		/>
	)

	return run
}

// Picks a select's option as a mouse does.
function choose(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(option, { button: 0 })
	fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(option, { button: 0 })
	fireEvent.click(option)
}

function trigger(name: string): HTMLElement {
	return screen.getByRole("combobox", { name })
}

// The closed select's text (what its value shows, without the trigger's icon).
function shown(name: string): string | null | undefined {
	return trigger(name).querySelector("[data-slot='select-value']")?.textContent
}

function field(name: string): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("textbox", { name })
}

function ok(): HTMLButtonElement {
	return screen.getByRole<HTMLButtonElement>("button", { name: preview.previewSheetFilterApply })
}

const OPERATOR_1 = preview.previewSheetFilterConditionOperator.replace("{{number}}", "1")
const OPERATOR_2 = preview.previewSheetFilterConditionOperator.replace("{{number}}", "2")
const VALUE_1 = preview.previewSheetFilterConditionValue.replace("{{number}}", "1")
const VALUE_2 = preview.previewSheetFilterConditionValue.replace("{{number}}", "2")

describe("the Custom filter dialog", () => {
	it("shows each condition's operator by its text, the unused second as (none), each row under its own names", () => {
		renderCondition({ first: "notContains" })

		expect(shown(OPERATOR_1)).toBe(preview.previewSheetFilterOpNotContains)
		expect(shown(OPERATOR_2)).toBe(preview.previewSheetFilterOpNone)
		expect(field(VALUE_1)).toBeTruthy()
		expect(field(VALUE_2).disabled).toBe(true)
	})

	it("sends one condition as a custom filter with Excel's wildcards", async () => {
		const run = renderCondition({ first: "equals" })

		fireEvent.click(trigger(OPERATOR_1))
		choose(await screen.findByRole("option", { name: preview.previewSheetFilterOpContains }))
		expect(shown(OPERATOR_1)).toBe(preview.previewSheetFilterOpContains)
		fireEvent.change(field(VALUE_1), { target: { value: "app" } })
		fireEvent.click(ok())

		expect(run).toHaveBeenCalledWith({
			type: "filter.column",
			sheet: 3,
			row: 0,
			col: 2,
			criteria: { kind: "custom", and: false, conditions: [{ operator: "equal", value: "*app*" }] }
		})
	})

	it("opens Between with both conditions joined by And, and sends them both or either", () => {
		const run = renderCondition({ kind: "number", first: "greaterOrEqual", second: "lessOrEqual" })

		expect(shown(OPERATOR_1)).toBe(preview.previewSheetFilterOpGreaterOrEqual)
		expect(shown(OPERATOR_2)).toBe(preview.previewSheetFilterOpLessOrEqual)
		expect(screen.getByRole("radio", { name: preview.previewSheetFilterAnd }).getAttribute("aria-checked")).toBe("true")
		fireEvent.change(field(VALUE_1), { target: { value: "5" } })
		fireEvent.change(field(VALUE_2), { target: { value: "10" } })
		fireEvent.click(ok())

		expect(run).toHaveBeenLastCalledWith(
			expect.objectContaining({
				criteria: {
					kind: "custom",
					and: true,
					conditions: [
						{ operator: "greaterThanOrEqual", value: "5" },
						{ operator: "lessThanOrEqual", value: "10" }
					]
				}
			})
		)

		cleanup()

		const either = renderCondition({ kind: "number", first: "greaterOrEqual", second: "lessOrEqual" })

		fireEvent.change(field(VALUE_1), { target: { value: "5" } })
		fireEvent.change(field(VALUE_2), { target: { value: "10" } })
		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetFilterOr }))
		fireEvent.click(ok())

		expect(either).toHaveBeenLastCalledWith(
			expect.objectContaining({
				criteria: {
					kind: "custom",
					and: false,
					conditions: [
						{ operator: "greaterThanOrEqual", value: "5" },
						{ operator: "lessThanOrEqual", value: "10" }
					]
				}
			})
		)
	})

	it("drops a second condition left empty", () => {
		const run = renderCondition({ kind: "number", first: "greaterOrEqual", second: "lessOrEqual" })

		fireEvent.change(field(VALUE_1), { target: { value: "5" } })
		fireEvent.click(ok())

		expect(run).toHaveBeenLastCalledWith(
			expect.objectContaining({
				criteria: { kind: "custom", and: false, conditions: [{ operator: "greaterThanOrEqual", value: "5" }] }
			})
		)
	})

	it("refuses a value that does not read as a number on a column of numbers, saying why", () => {
		const run = renderCondition({ kind: "number", first: "greater" })

		fireEvent.change(field(VALUE_1), { target: { value: "abc" } })

		expect(screen.getByRole("alert").textContent).toBe(preview.previewSheetFilterNotANumber)
		expect(ok().disabled).toBe(true)
		fireEvent.click(ok())
		expect(run).not.toHaveBeenCalled()
	})

	it("reads stored conditions back into both rows", () => {
		renderCondition({
			kind: "number",
			first: "equals",
			criteria: {
				kind: "custom",
				and: false,
				conditions: [
					{ operator: "greaterThan", value: "1" },
					{ operator: "lessThanOrEqual", value: "9" }
				]
			}
		})

		expect(shown(OPERATOR_1)).toBe(preview.previewSheetFilterOpGreater)
		expect(field(VALUE_1).value).toBe("1")
		expect(shown(OPERATOR_2)).toBe(preview.previewSheetFilterOpLessOrEqual)
		expect(field(VALUE_2).value).toBe("9")
		expect(screen.getByRole("radio", { name: preview.previewSheetFilterOr }).getAttribute("aria-checked")).toBe("true")
	})
})

describe("the Top 10 dialog", () => {
	function count(): HTMLInputElement {
		return screen.getByRole<HTMLInputElement>("spinbutton", { name: preview.previewSheetFilterTopCount })
	}

	it("shows the direction and the unit by their text, each under its own name", () => {
		renderTop10()

		expect(shown(preview.previewSheetFilterTopDirection)).toBe(preview.previewSheetFilterTop)
		expect(shown(preview.previewSheetFilterTopUnit)).toBe(preview.previewSheetFilterItems)
		expect(count().value).toBe("10")
	})

	it("takes a whole number up to 500 items or 100 percent", async () => {
		const run = renderTop10()

		for (const value of ["0", "501", "2.5", ""]) {
			fireEvent.change(count(), { target: { value } })
			expect(ok().disabled).toBe(true)
		}

		fireEvent.change(count(), { target: { value: "500" } })
		expect(ok().disabled).toBe(false)

		fireEvent.click(trigger(preview.previewSheetFilterTopUnit))
		choose(await screen.findByRole("option", { name: preview.previewSheetFilterPercent }))
		expect(shown(preview.previewSheetFilterTopUnit)).toBe(preview.previewSheetFilterPercent)
		expect(ok().disabled).toBe(true)

		fireEvent.change(count(), { target: { value: "101" } })
		expect(ok().disabled).toBe(true)
		fireEvent.change(count(), { target: { value: "100" } })

		fireEvent.click(trigger(preview.previewSheetFilterTopDirection))
		choose(await screen.findByRole("option", { name: preview.previewSheetFilterBottom }))
		expect(shown(preview.previewSheetFilterTopDirection)).toBe(preview.previewSheetFilterBottom)
		fireEvent.click(ok())

		expect(run).toHaveBeenCalledWith({
			type: "filter.column",
			sheet: 3,
			row: 0,
			col: 2,
			criteria: { kind: "top10", top: false, percent: true, value: 100 }
		})
	})

	it("reads a stored Top 10 back", () => {
		renderTop10({ kind: "top10", top: false, percent: true, value: 25 })

		expect(shown(preview.previewSheetFilterTopDirection)).toBe(preview.previewSheetFilterBottom)
		expect(shown(preview.previewSheetFilterTopUnit)).toBe(preview.previewSheetFilterPercent)
		expect(count().value).toBe("25")
	})
})
