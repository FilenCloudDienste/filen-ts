// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { previewMarkdownUrlTransform } from "@/features/preview/components/markdownViewer.logic"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// A markdown file in the preview: formulas painted as MathML (an unreadable one shows its source), prices left as
// text, images never fetched (a data: image shows). Notes and assistant replies render none of it.

afterEach(() => {
	cleanup()
})

const MATHML = "http://www.w3.org/1998/Math/MathML"

describe("the preview's markdown", () => {
	it("paints inline and display math as MathML", () => {
		const { container } = render(
			<PreviewMarkdown
				text={"Area $\\pi r^2$ of a circle.\n\n$$\n\\frac{a}{b}\n$$"}
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		const formulas = [...container.querySelectorAll("span[role=math]")]

		expect(formulas.map(formula => formula.getAttribute("aria-label"))).toEqual(["\\pi r^2", "\\frac{a}{b}"])
		expect(formulas.every(formula => formula.firstElementChild?.namespaceURI === MATHML)).toBe(true)
		expect(formulas[1]?.firstElementChild?.getAttribute("display")).toBe("block")
		// Display math is no code block.
		expect(container.querySelector("pre")).toBeNull()
	})

	it("shows a formula it cannot read as its source, with the reason", () => {
		render(
			<PreviewMarkdown
				text={"See $\\nosuchcommand{x}$ here."}
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		const source = screen.getByText("$\\nosuchcommand{x}$")

		expect(source.tagName).toBe("CODE")
		expect(source.getAttribute("title")).not.toBe("")
	})

	it("paints a ```math fence as display math, as GitHub does", () => {
		const { container } = render(
			<PreviewMarkdown
				text={"```math\n\\frac{a}{b}\n```\n\n```mathematica\nx\n```"}
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		const formulas = [...container.querySelectorAll("span[role=math]")]

		expect(formulas.map(formula => formula.getAttribute("aria-label"))).toEqual(["\\frac{a}{b}"])
		expect(formulas[0]?.firstElementChild?.getAttribute("display")).toBe("block")
		// Only the other fence is a code block.
		expect([...container.querySelectorAll("pre")].map(pre => pre.textContent)).toEqual(["x\n"])
	})

	it("keeps prices text", () => {
		render(
			<PreviewMarkdown
				text="It costs $5 and $10 today."
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.queryByRole("math")).toBeNull()
		expect(screen.getByText("It costs $5 and $10 today.")).toBeTruthy()
	})

	it("names an image instead of loading it, and shows a data: image", () => {
		const { container } = render(
			<PreviewMarkdown
				text={"![chart](https://example.com/chart.png) ![dot](data:image/png;base64,iVBORw0KGgo=)"}
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.getByText("[image: chart] (not loaded)")).toBeTruthy()
		expect([...container.querySelectorAll("img")].map(img => img.getAttribute("src"))).toEqual(["data:image/png;base64,iVBORw0KGgo="])
	})

	it("leaves the shared surface (notes, assistant) without math", () => {
		render(
			<MarkdownRenderer
				text="$x^2$"
				alt="note"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.queryByRole("math")).toBeNull()
		expect(screen.getByText("$x^2$")).toBeTruthy()
	})
})

describe("previewMarkdownUrlTransform", () => {
	it("keeps a data: image source, and links only by the link policy", () => {
		expect(previewMarkdownUrlTransform("data:image/png;base64,AA==", "src")).toBe("data:image/png;base64,AA==")
		expect(previewMarkdownUrlTransform("data:image/png;base64,AA==", "href")).toBeUndefined()
		expect(previewMarkdownUrlTransform("data:text/html,x", "src")).toBeUndefined()
		expect(previewMarkdownUrlTransform("https://example.com/a.png", "src")).toBe("https://example.com/a.png")
	})
})
