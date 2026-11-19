// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { TimecodeField } from "@/features/preview/videoEdit/components/timecodeField"

// The timecode field: Enter and blur commit a parsed time, a change under 5 ms commits nothing, Escape reverts
// without committing and without reaching the editor, a typo raises an alert that the next timeline value drops, and
// the keyboard it asks for can type a colon.

function mount(value: number) {
	const onCommit = vi.fn()
	const view = render(
		<TimecodeField
			label="Start"
			value={value}
			onCommit={onCommit}
		/>
	)
	const input = screen.getByLabelText("Start")

	if (!(input instanceof HTMLInputElement)) {
		throw new Error("TimecodeField renders no input")
	}

	return { view, input, onCommit }
}

afterEach(() => {
	cleanup()
})

describe("TimecodeField", () => {
	it("commits a parsed time on Enter", () => {
		const { input, onCommit } = mount(0)

		fireEvent.change(input, { target: { value: "1:05.25" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(onCommit).toHaveBeenCalledTimes(1)
		expect(onCommit).toHaveBeenCalledWith(65.25)
	})

	it("commits a parsed time on blur", () => {
		const { input, onCommit } = mount(0)

		fireEvent.change(input, { target: { value: "01:00:00" } })
		fireEvent.blur(input)

		expect(onCommit).toHaveBeenCalledWith(3600)
	})

	it("does not commit a change under 5 ms", () => {
		const { input, onCommit } = mount(10)

		fireEvent.change(input, { target: { value: "10.004" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(onCommit).not.toHaveBeenCalled()
	})

	it("reverts on Escape without committing or letting the key reach the editor", () => {
		const { input, onCommit } = mount(5)
		const shown = input.value
		const outer = vi.fn()

		document.addEventListener("keydown", outer)
		fireEvent.change(input, { target: { value: "9" } })
		fireEvent.keyDown(input, { key: "Escape" })

		expect(input.value).toBe(shown)
		expect(outer).not.toHaveBeenCalled()

		document.removeEventListener("keydown", outer)
		fireEvent.blur(input)

		expect(onCommit).not.toHaveBeenCalled()
	})

	it("announces a typo and drops it when the value changes", () => {
		const { view, input, onCommit } = mount(5)

		fireEvent.change(input, { target: { value: "abc" } })
		fireEvent.blur(input)

		expect(onCommit).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toBeTruthy()
		expect(input.getAttribute("aria-invalid")).toBe("true")

		view.rerender(
			<TimecodeField
				label="Start"
				value={7}
				onCommit={onCommit}
			/>
		)

		expect(screen.queryByRole("alert")).toBeNull()
		expect(input.getAttribute("aria-invalid")).toBe("false")

		view.rerender(
			<TimecodeField
				label="Start"
				value={5}
				onCommit={onCommit}
			/>
		)

		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("asks for a keyboard that can type a colon", () => {
		const { input } = mount(0)

		expect(input.getAttribute("inputmode")).toBe("text")
	})
})
