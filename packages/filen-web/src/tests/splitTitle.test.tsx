// @vitest-environment jsdom

import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { SplitTitle } from "@/features/preview/components/splitTitle"

afterEach(cleanup)

// The class of each rendered half: its white-space mode decides whether a space at the split survives.
function halves(text: string, tailLength: number): { text: string; className: string }[] {
	const { container } = render(createElement(SplitTitle, { text, tailLength }))

	return [...container.querySelectorAll("span")].map(span => ({ text: span.textContent, className: span.className }))
}

describe("SplitTitle", () => {
	it("keeps the space where a long name splits next to it", () => {
		const parts = halves("Untitled presentation.odp", 16)

		expect(parts.map(part => part.text)).toEqual(["Untitled ", "presentation.odp"])

		// white-space: pre keeps a space at a line edge; nowrap and normal (truncate) collapse it away.
		for (const part of parts) {
			expect(part.className.split(" ")).toContain("whitespace-pre")
			expect(part.className).not.toMatch(/whitespace-nowrap|truncate/u)
		}
	})

	it("leaves a short name whole", () => {
		expect(halves("short.odp", 16).map(part => part.text)).toEqual(["short.odp"])
	})
})
