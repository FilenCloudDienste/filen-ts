// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MermaidFileDiagram } from "@/features/preview/components/mermaidDiagram"
import { MermaidHost } from "@/features/preview/lib/mermaidFrame"
import { MERMAID_AUTO_RENDER_LIMIT } from "@/features/preview/lib/mermaidScope"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "dark" }), resolveTheme: () => "dark" }))

// Mermaid in the file preview: fences drawn as they come near, the first 50 of a document on their own and the rest on
// request; refused and oversized diagrams named; a .mmd's diagram drawn at once. Notes and assistant replies keep
// fences as code.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

// Every observed element, to bring near by hand, and those no longer watched.
const observed: { element: Element; callback: IntersectionObserverCallback; observer: IntersectionObserver }[] = []
const unobserved = new Set<Element>()

class FakeIntersectionObserver {
	private readonly callback: IntersectionObserverCallback

	public constructor(callback: IntersectionObserverCallback) {
		this.callback = callback
	}

	public observe(element: Element): void {
		observed.push({ element, callback: this.callback, observer: this as unknown as IntersectionObserver })
	}
	public unobserve(element: Element): void {
		unobserved.add(element)
	}

	public disconnect(): void {
		for (const entry of observed) {
			unobserved.add(entry.element)
		}
	}
}

function bringNear(index: number): void {
	const entry = observed[index]

	if (entry === undefined) {
		throw new Error(`no observed element ${String(index)}`)
	}

	act(() => {
		entry.callback(
			[{ target: entry.element, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
			entry.observer
		)
	})
}

function fences(count: number): string {
	return Array.from({ length: count }, (_, index) => `\`\`\`mermaid\ngraph TD; A${String(index)}-->B\n\`\`\``).join("\n\n")
}

let renderSpy: MockInstance<MermaidHost["render"]>

beforeEach(() => {
	observed.length = 0
	unobserved.clear()
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
	vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:diagram", revokeObjectURL: () => undefined }))
	renderSpy = vi
		.spyOn(MermaidHost.prototype, "render")
		.mockResolvedValue({ kind: "svg", url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}` })
})

afterEach(() => {
	cleanup()
})

const wrapper = queryClientWrapper(createTestQueryClient())

describe("Mermaid fences in the file preview", () => {
	it("draws a fence once it comes near, in the app's theme", async () => {
		render(
			<PreviewMarkdown
				text={fences(1)}
				alt="flows.md"
			/>,
			{ wrapper }
		)

		const placeholder = screen.getByRole("status")

		// "Rendering diagram…" at about the diagram's size, so the drawing does not push the text below it.
		expect(placeholder.textContent).toBe("Rendering diagram…")
		expect(placeholder.style.minHeight).toBe("96px")
		expect(renderSpy).not.toHaveBeenCalled()

		bringNear(0)

		const image = await screen.findByRole("img", { name: "Mermaid diagram" })

		// A data: URL, never a blob: URL of the app's origin.
		expect(image.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true)
		// Out of the flow until it has loaded: the placeholder keeps its place till then.
		expect(image.className).toContain("absolute")
		expect(screen.getByRole("status")).toBeTruthy()

		fireEvent.load(image)

		expect(image.className).not.toContain("absolute")
		expect(screen.queryByRole("status")).toBeNull()
		expect(renderSpy).toHaveBeenCalledWith("graph TD; A0-->B\n", "dark")
		// Watched until it came near, not after.
		expect(unobserved.has(observed[0]?.element ?? document.body)).toBe(true)
	})

	it(`draws the first ${String(MERMAID_AUTO_RENDER_LIMIT)} on their own and asks before the rest`, async () => {
		render(
			<PreviewMarkdown
				text={fences(MERMAID_AUTO_RENDER_LIMIT + 1)}
				alt="flows.md"
			/>,
			{ wrapper }
		)

		expect(observed).toHaveLength(MERMAID_AUTO_RENDER_LIMIT)

		const button = screen.getByRole("button", { name: "Render diagram" })

		fireEvent.click(button)

		expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeTruthy()
		expect(renderSpy).toHaveBeenCalledTimes(1)
		expect(renderSpy).toHaveBeenCalledWith(`graph TD; A${String(MERMAID_AUTO_RENDER_LIMIT)}-->B\n`, "dark")
	})

	it("names a diagram that loads images or links once it comes near, with its source on request, and never draws it", async () => {
		render(
			<PreviewMarkdown
				text={'```mermaid\ngraph TD; A-->B\nclick A href "https://example.com"\n```'}
				alt="flows.md"
			/>,
			{ wrapper }
		)

		// Far away it is not even judged.
		expect(screen.queryByText("This diagram uses images or links, which previews don't load.")).toBeNull()

		bringNear(0)

		expect(await screen.findByText("This diagram uses images or links, which previews don't load.")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Show source" }))
		expect(screen.getByText(/click A href/)).toBeTruthy()
		expect(renderSpy).not.toHaveBeenCalled()
	})

	it("says a diagram the frame gave up on is too complex, and shows one it could not draw as its source", async () => {
		renderSpy.mockResolvedValueOnce({ kind: "tooComplex" }).mockResolvedValueOnce({ kind: "failed" })

		render(
			<PreviewMarkdown
				text={fences(2)}
				alt="flows.md"
			/>,
			{ wrapper }
		)
		bringNear(0)
		bringNear(1)

		expect(await screen.findByText("Diagram too complex to preview")).toBeTruthy()

		const source = await screen.findByText("graph TD; A1-->B")

		expect(source.getAttribute("title")).toBe("This diagram can't be shown.")
	})

	it("leaves notes and assistant replies with the fence as code", () => {
		const { container } = render(
			<MarkdownRenderer
				text={fences(1)}
				alt="note"
			/>,
			{ wrapper }
		)

		expect(container.querySelector("pre > code.language-mermaid")?.textContent).toBe("graph TD; A0-->B\n")
		expect(observed).toEqual([])
	})
})

describe("a Mermaid file", () => {
	it("draws its diagram at once", async () => {
		render(<MermaidFileDiagram source={"pie\n  'a': 1"} />, { wrapper })

		expect(await screen.findByRole("img", { name: "Mermaid diagram" })).toBeTruthy()
		expect(renderSpy).toHaveBeenCalledWith("pie\n  'a': 1", "dark")
	})
})
