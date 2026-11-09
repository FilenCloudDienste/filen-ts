// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { registerAllActions } from "@/lib/keymap/actions"
import "@/lib/i18n"

// Word's "Find whole words only" in the find bar: shown only where the find has the option, and kept with Match case.

registerAllActions()

afterEach(() => {
	cleanup()
})

function controls(overrides: Partial<DocxFindControls>): DocxFindControls {
	return {
		query: "the",
		caseSensitive: false,
		count: 2,
		capped: false,
		active: 0,
		search: () => undefined,
		step: () => undefined,
		close: () => undefined,
		...overrides
	}
}

function field(find: DocxFindControls): void {
	render(
		<DocxFindField
			find={find}
			focus={0}
			onClosed={() => undefined}
		/>
	)
}

describe("the find bar's whole words option", () => {
	it("is not offered where the find has no such option", () => {
		field(controls({}))

		expect(screen.getByRole("button", { name: "Match case" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Find whole words only" })).toBeNull()
	})

	it("toggles a whole-word search of the field's text, keeping the case option", () => {
		const search = vi.fn()

		field(controls({ wholeWord: false, caseSensitive: true, search }))

		const toggle = screen.getByRole("button", { name: "Find whole words only" })

		expect(toggle.getAttribute("aria-pressed")).toBe("false")
		fireEvent.click(toggle)
		expect(search).toHaveBeenLastCalledWith("the", true, true)
	})

	it("Match case and Enter keep whole words on", () => {
		const search = vi.fn()

		field(controls({ wholeWord: true, search }))

		expect(screen.getByRole("button", { name: "Find whole words only" }).getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: "Match case" }))
		expect(search).toHaveBeenLastCalledWith("the", true, true)

		const input = screen.getByRole("searchbox", { name: "Find" })

		fireEvent.change(input, { target: { value: "then" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(search).toHaveBeenLastCalledWith("then", false, true)
	})
})
