// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { AfterwardsField } from "@/features/drive/components/afterwardsField"

afterEach(() => {
	cleanup()
})

describe("AfterwardsField", () => {
	it("speaks of the originals for a compress", () => {
		const onChange = vi.fn()

		render(createElement(AfterwardsField, { kind: "compress", value: "keep", onChange }))

		expect(screen.getByRole("radio", { name: "Keep the originals" })).toBeTruthy()
		expect(screen.getByRole("radio", { name: "Move the originals to the trash" })).toBeTruthy()
		expect(screen.getByText("Once the result is checked. They will not be in the trash.")).toBeTruthy()

		fireEvent.click(screen.getByRole("radio", { name: "Delete the originals permanently" }))

		expect(onChange).toHaveBeenCalledWith("deletePermanently")
	})

	it("speaks of the archive for an extract", () => {
		const onChange = vi.fn()

		render(createElement(AfterwardsField, { kind: "extract", value: "keep", onChange }))

		expect(screen.getByRole("radio", { name: "Keep the archive" })).toBeTruthy()
		expect(screen.getByRole("radio", { name: "Delete the archive permanently" })).toBeTruthy()
		expect(screen.getByText("Once everything is extracted and checked. You can restore it from the trash.")).toBeTruthy()
		expect(screen.queryByText(/originals/)).toBeNull()
		expect(screen.getAllByRole("radio")).toHaveLength(3)

		fireEvent.click(screen.getByRole("radio", { name: "Move the archive to the trash" }))

		expect(onChange).toHaveBeenCalledWith("trash")
	})
})
