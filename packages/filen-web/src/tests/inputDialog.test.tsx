// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { InputDialog, type InputDialogProps } from "@/components/dialogs/inputDialog"
import { TypedConfirmDialog, type TypedConfirmDialogProps } from "@/components/dialogs/typedConfirmDialog"

function inputDialogProps(overrides: Partial<InputDialogProps> = {}): InputDialogProps {
	return {
		open: true,
		pending: false,
		title: "Rename",
		body: "Enter a new name",
		label: "Name",
		initialValue: "a.txt",
		selectBaseName: true,
		submitLabel: "Rename",
		validate: value => value.length > 0,
		onOpenChange: vi.fn(),
		onSubmit: vi.fn(),
		...overrides
	}
}

function typedConfirmProps(overrides: Partial<TypedConfirmDialogProps> = {}): TypedConfirmDialogProps {
	return {
		open: true,
		pending: false,
		title: "Empty trash",
		body: "This cannot be undone",
		matchLabel: "Type EMPTY",
		matchValue: "EMPTY",
		confirmLabel: "Empty",
		cancelLabel: "Cancel",
		onOpenChange: vi.fn(),
		onConfirm: vi.fn(),
		...overrides
	}
}

function field(id: string): HTMLInputElement {
	const element = document.getElementById(id)

	if (!(element instanceof HTMLInputElement)) {
		throw new Error(`#${id} is not an input`)
	}

	return element
}

function selection(input: HTMLInputElement): [number | null, number | null] {
	return [input.selectionStart, input.selectionEnd]
}

describe("InputDialog selection", () => {
	it("selects the base name once per open, not on every focus", async () => {
		const props = inputDialogProps()
		const { rerender } = render(<InputDialog {...props} />)

		await screen.findByRole("dialog")

		const first = field("input-dialog-value")

		fireEvent.focus(first)
		expect(selection(first)).toEqual([0, 1])

		// The caret moved by the user, then the window regains focus: the edit position stays.
		first.setSelectionRange(3, 3)
		fireEvent.focus(first)
		expect(selection(first)).toEqual([3, 3])

		rerender(
			<InputDialog
				{...props}
				open={false}
			/>
		)
		rerender(<InputDialog {...props} />)
		await screen.findByRole("dialog")

		// The dialog's initial focus on the new open selects the base name again.
		const reopened = field("input-dialog-value")

		expect(document.activeElement).toBe(reopened)
		expect(selection(reopened)).toEqual([0, 1])
	})
})

describe("InputDialog pending", () => {
	it("keeps the field focused and read-only while pending, editable after", async () => {
		const props = inputDialogProps({ selectBaseName: false })
		const { rerender } = render(<InputDialog {...props} />)

		await screen.findByRole("dialog")

		const input = field("input-dialog-value")

		input.focus()
		fireEvent.submit(input.form ?? input)
		expect(props.onSubmit).toHaveBeenCalledWith("a.txt")

		rerender(
			<InputDialog
				{...props}
				pending
			/>
		)
		expect(input.readOnly).toBe(true)
		expect(input.disabled).toBe(false)
		expect(input.form?.getAttribute("aria-busy")).toBe("true")
		expect(document.activeElement).toBe(input)

		rerender(<InputDialog {...props} />)
		expect(input.readOnly).toBe(false)
		expect(input.form?.getAttribute("aria-busy")).toBe("false")
		expect(document.activeElement).toBe(input)
	})
})

describe("TypedConfirmDialog pending", () => {
	it("keeps the field focused and read-only while pending, editable after", async () => {
		const props = typedConfirmProps()
		const { rerender } = render(<TypedConfirmDialog {...props} />)

		await screen.findByRole("alertdialog")

		const input = field("typed-confirm-value")

		input.focus()
		fireEvent.change(input, { target: { value: "EMPTY" } })
		fireEvent.submit(input.form ?? input)
		expect(props.onConfirm).toHaveBeenCalledTimes(1)

		rerender(
			<TypedConfirmDialog
				{...props}
				pending
			/>
		)
		expect(input.readOnly).toBe(true)
		expect(input.disabled).toBe(false)
		expect(input.form?.getAttribute("aria-busy")).toBe("true")
		expect(document.activeElement).toBe(input)

		rerender(<TypedConfirmDialog {...props} />)
		expect(input.readOnly).toBe(false)
		expect(document.activeElement).toBe(input)
	})
})
