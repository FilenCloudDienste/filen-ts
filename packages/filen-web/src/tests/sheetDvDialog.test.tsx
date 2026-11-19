// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type {
	SheetCommand,
	SheetCommandResult,
	SheetRefusal,
	SheetSessionApi,
	SheetValidationAlert,
	SheetValidationRule
} from "@filen/office/core/sheet"
import type { SheetGridHandle, SheetGridModel, SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"
import { ValidationDialog } from "@/features/spreadsheet/data/dvDialog"
import { NEW_RULE, validationComplete, validationFields, validationRefusalKey } from "@/features/spreadsheet/data/dvDialog.logic"
import { ALERT_BUTTONS, useValidationAlert, type ValidationVerdict } from "@/features/spreadsheet/data/dvAlert"
import { checkEntry, useSheetConditional } from "@/features/spreadsheet/data/cfExtension"

// The Data validation dialog (Excel's fields per kind, the rule sent, a refusal shown), the alert an invalid entry
// shows with Excel's buttons per style, and an entry checked before it is written.

afterEach(() => {
	cleanup()
})

describe("the Data validation dialog's fields", () => {
	it("asks each kind of rule for what it takes, as Excel's dialog does", () => {
		expect(validationFields({ type: "none", operator: "between" })).toEqual([])
		expect(validationFields({ type: "list", operator: "between" })).toEqual(["source"])
		expect(validationFields({ type: "custom", operator: "between" })).toEqual(["formula"])
		expect(validationFields({ type: "whole", operator: "between" })).toEqual(["operator", "minimum", "maximum"])
		expect(validationFields({ type: "date", operator: "greaterThan" })).toEqual(["operator", "value"])
		expect(validationComplete({ ...NEW_RULE, type: "whole", value1: "1" })).toBe(false)
		expect(validationComplete({ ...NEW_RULE, type: "whole", value1: "1", value2: "2" })).toBe(true)
		expect(validationComplete(NEW_RULE)).toBe(true)
		expect(validationRefusalKey("tooLarge", { ...NEW_RULE, type: "list", value1: "x".repeat(300) })).toBe(
			"previewSheetValidationListTooLong"
		)
		expect(validationRefusalKey("formula", NEW_RULE)).toBe("previewSheetValidationInvalidValue")
	})

	it("sends the rule as edited, and shows why the session refused it", async () => {
		const onApply = vi
			.fn<(rule: SheetValidationRule) => Promise<SheetRefusal | null>>()
			.mockResolvedValueOnce({ reason: "formula" })
			.mockResolvedValueOnce(null)
		const onClose = vi.fn()

		render(
			<ValidationDialog
				rule={{ ...NEW_RULE, type: "list" }}
				kind="xlsx"
				onClose={onClose}
				onApply={onApply}
				onClear={() => undefined}
			/>
		)

		fireEvent.change(screen.getByLabelText(preview.previewSheetValidationSource), { target: { value: "=SUM(" } })
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOk }))
			await Promise.resolve()
		})

		expect(onApply).toHaveBeenLastCalledWith({ ...NEW_RULE, type: "list", value1: "=SUM(" })
		expect(screen.getByText(preview.previewSheetValidationInvalidValue)).toBeTruthy()
		expect(onClose).not.toHaveBeenCalled()

		fireEvent.change(screen.getByLabelText(preview.previewSheetValidationSource), { target: { value: "Yes,No" } })
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOk }))
			await Promise.resolve()
		})

		expect(onApply).toHaveBeenLastCalledWith({ ...NEW_RULE, type: "list", value1: "Yes,No" })
		expect(onClose).toHaveBeenCalled()
	})

	it("writes the input and error messages in boxes of several lines, as Excel's dialog has them", async () => {
		const onApply = vi.fn<(rule: SheetValidationRule) => Promise<SheetRefusal | null>>().mockResolvedValue(null)

		render(
			<ValidationDialog
				rule={{ ...NEW_RULE, showInputMessage: true }}
				kind="xlsx"
				onClose={() => undefined}
				onApply={onApply}
				onClear={() => undefined}
			/>
		)

		const [prompt, error] = screen.getAllByLabelText(preview.previewSheetValidationMessageText)

		if (prompt === undefined || error === undefined) throw new Error("No message fields")

		expect(prompt.tagName).toBe("TEXTAREA")
		expect(error.tagName).toBe("TEXTAREA")
		fireEvent.change(prompt, { target: { value: "First line\nSecond line" } })
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOk }))
			await Promise.resolve()
		})

		expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "First line\nSecond line" }))
	})

	it("clears the selection's validation", () => {
		const onClear = vi.fn()

		render(
			<ValidationDialog
				rule={NEW_RULE}
				kind="xlsx"
				onClose={() => undefined}
				onApply={() => Promise.resolve(null)}
				onClear={onClear}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationClearAll }))
		expect(onClear).toHaveBeenCalled()
	})

	it("says a refusal that is not about the rule in the app's words, not as an invalid value", async () => {
		const onApply = vi
			.fn<(rule: SheetValidationRule) => Promise<SheetRefusal | null>>()
			.mockResolvedValue({ reason: "readOnly", detail: "signed" })

		render(
			<ValidationDialog
				rule={{ ...NEW_RULE, type: "list", value1: "Yes,No" }}
				kind="xlsx"
				onClose={() => undefined}
				onApply={onApply}
				onClear={() => undefined}
			/>
		)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOk }))
			await Promise.resolve()
		})

		expect(screen.getByText(preview.previewSheetReadOnlySigned)).toBeTruthy()
		expect(screen.queryByText(preview.previewSheetValidationInvalidValue)).toBeNull()
	})
})

function ConditionalHarness({ model, session }: { model: SheetGridModel; session: SheetSessionApi }) {
	const grid = {
		sheet: 1,
		selection: { active: { row: 0, col: 0 }, ranges: [{ top: 0, left: 0, bottom: 0, right: 0 }] },
		editing: null
	} as unknown as SheetGridState
	const extension = useSheetConditional({
		grid,
		model,
		gridRef: { current: null },
		session,
		canEdit: true,
		text: false,
		run: () => undefined
	})

	return (
		<>
			<button
				type="button"
				onClick={() => {
					extension.ribbon?.dataValidation?.()
				}}
			>
				open
			</button>
			{extension.dialogs}
		</>
	)
}

describe("the Data validation dialog in the sheet", () => {
	it("clears with the model reporting a refusal, so a refused Clear all toasts", async () => {
		const onRefusal = vi.fn()
		const refusal: SheetRefusal = { reason: "protectedSheet" }
		const command = vi.fn((_command: SheetCommand, report = true): Promise<SheetCommandResult> => {
			if (report) onRefusal(refusal)

			return Promise.resolve({ ok: false, refusal } as SheetCommandResult)
		})
		const model = { kind: "xlsx", intent: () => Promise.resolve(), command } as unknown as SheetGridModel
		const session = { query: () => Promise.resolve(NEW_RULE) } as unknown as SheetSessionApi

		render(
			<ConditionalHarness
				model={model}
				session={session}
			/>
		)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "open" }))
			await Promise.resolve()
		})
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationClearAll }))
			await Promise.resolve()
		})

		expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: "validation.set", rule: null }))
		expect(onRefusal).toHaveBeenCalledWith(refusal)
	})
})

function AlertHarness({
	alerts: asked,
	onVerdict,
	focus = () => undefined,
	editing = false
}: {
	alerts: readonly SheetValidationAlert[]
	onVerdict: (verdict: ValidationVerdict, index: number) => void
	focus?: () => void
	editing?: boolean
}) {
	const alerts = useValidationAlert({ current: { focus } as unknown as SheetGridHandle }, editing)

	return (
		<>
			<button
				type="button"
				onClick={() => {
					asked.forEach((alert, index) => {
						void alerts.ask(alert).then(verdict => {
							onVerdict(verdict, index)
						})
					})
				}}
			>
				ask
			</button>
			{alerts.dialog}
		</>
	)
}

describe("the invalid entry alert", () => {
	it("gives Excel's buttons for each style", () => {
		expect(ALERT_BUTTONS.stop.map(button => button.verdict)).toEqual(["edit", "discard"])
		expect(ALERT_BUTTONS.warning.map(button => button.verdict)).toEqual(["commit", "edit", "discard"])
		expect(ALERT_BUTTONS.information.map(button => button.verdict)).toEqual(["commit", "discard"])
	})

	it("shows the file's words or the app's, and answers with the button chosen", async () => {
		const onVerdict = vi.fn()

		render(
			<AlertHarness
				alerts={[{ style: "warning", title: null, message: "Over budget" }]}
				onVerdict={onVerdict}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "ask" }))

		expect(screen.getByText(preview.previewSheetValidationAlertTitle)).toBeTruthy()
		expect(screen.getByText(/Over budget/u)).toBeTruthy()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationNo }))
			await Promise.resolve()
		})

		expect(onVerdict).toHaveBeenCalledWith("edit", 0)
	})

	it("asks about each entry in turn when a second is checked while the first alert is open", async () => {
		const onVerdict = vi.fn()

		render(
			<AlertHarness
				alerts={[
					{ style: "stop", title: null, message: "First" },
					{ style: "information", title: null, message: "Second" }
				]}
				onVerdict={onVerdict}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "ask" }))
		expect(screen.getByText("First")).toBeTruthy()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: common.cancel }))
			await Promise.resolve()
		})

		expect(onVerdict).toHaveBeenCalledWith("discard", 0)
		expect(onVerdict).not.toHaveBeenCalledWith(expect.anything(), 1)
		expect(screen.getByText("Second")).toBeTruthy()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationOk }))
			await Promise.resolve()
		})

		expect(onVerdict).toHaveBeenCalledWith("commit", 1)
	})

	it("waits while an entry is being typed, so that entry is never cut short", () => {
		const props = { alerts: [{ style: "stop", title: null, message: "Out of range" }] as const, onVerdict: () => undefined }
		const { rerender } = render(
			<AlertHarness
				{...props}
				editing
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "ask" }))
		expect(screen.queryByRole("alertdialog")).toBeNull()

		rerender(
			<AlertHarness
				{...props}
				editing={false}
			/>
		)
		expect(screen.getByRole("alertdialog")).toBeTruthy()
	})

	it("gives typing back to the grid once the last alert closes, unless Retry reopened the entry", async () => {
		const focus = vi.fn()

		render(
			<AlertHarness
				alerts={[{ style: "stop", title: null, message: "Out of range" }]}
				onVerdict={() => undefined}
				focus={focus}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "ask" }))
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
			await new Promise(resolve => setTimeout(resolve, 50))
		})

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(focus).toHaveBeenCalled()

		focus.mockClear()
		fireEvent.click(screen.getByRole("button", { name: "ask" }))
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewSheetValidationRetry }))
			await new Promise(resolve => setTimeout(resolve, 50))
		})

		expect(focus).not.toHaveBeenCalled()
	})
})

describe("an entry checked before it is written", () => {
	it("writes what passes, asks about what does not, and never blocks on a failed session", async () => {
		const query = vi.fn()
		const session = { query } as unknown as SheetSessionApi
		const ask = vi.fn<(alert: SheetValidationAlert) => Promise<ValidationVerdict>>().mockResolvedValue("discard")
		const entry = { sheet: 1, row: 2, col: 3, text: "11" }

		query.mockResolvedValueOnce(null)
		expect(await checkEntry(session, entry, ask)).toBe("commit")
		expect(query).toHaveBeenLastCalledWith("validation.check", { sheet: 1, row: 2, col: 3, input: "11" })

		query.mockResolvedValueOnce({ style: "stop", title: null, message: null })
		expect(await checkEntry(session, entry, ask)).toBe("discard")
		expect(ask).toHaveBeenCalledWith({ style: "stop", title: null, message: null })

		query.mockRejectedValueOnce(new Error("closed"))
		expect(await checkEntry(session, entry, ask)).toBe("commit")
	})
})
