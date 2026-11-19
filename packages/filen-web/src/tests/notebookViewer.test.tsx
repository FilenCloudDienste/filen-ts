// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { readNotebook } from "@/features/preview/lib/notebookReading"

// A notebook opens on its cells (read in the worker from the text the page decoded): the In [n] gutter, code highlighted,
// outputs under it, markdown rendered; its JSON source a toggle away.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const NOTEBOOK = JSON.stringify({
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { language_info: { name: "python" } },
	cells: [
		{ cell_type: "markdown", source: "# Analysis", metadata: {} },
		{
			cell_type: "code",
			source: "def total(x):\n    return x + 1",
			execution_count: 7,
			metadata: {},
			outputs: [
				{ output_type: "stream", name: "stdout", text: "printed line\n" },
				{ output_type: "display_data", data: { "image/png": PNG }, metadata: {} }
			]
		},
		{ cell_type: "code", source: "pass", execution_count: null, metadata: {}, outputs: [] }
	]
})

const { asked, notebook } = vi.hoisted(() => ({ asked: { current: [] as number[] }, notebook: { current: "" } }))

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light" }), resolveTheme: () => "light" }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([])
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode(notebook.current), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/emailSanitizer", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/emailSanitizer")>()

	return { ...actual, sanitizeEmailHtml: vi.fn(actual.sanitizeEmailHtml) }
})
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	readNotebookFile: (text: string, maxPixels: number) => {
		asked.current.push(maxPixels)

		return Promise.resolve(readNotebook(text, maxPixels))
	}
}))

interface Observed {
	callback: (entries: { isIntersecting: boolean }[]) => void
	root: Element | null
	targets: Element[]
}

const { NotebookViewer } = await import("@/features/preview/components/notebookViewer")
const { sanitizeEmailHtml } = await import("@/features/preview/lib/emailSanitizer")

registerAllActions()

beforeAll(() => {
	URL.createObjectURL = () => "blob:https://app.example/figure"
	URL.revokeObjectURL = () => undefined
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const ITEM = narrowItem({
	uuid: "file-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 100n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: {
		type: "decoded",
		data: { name: "analysis.ipynb", mime: "application/x-ipynb+json", modified: 0n, size: 100n, key: "k", version: 2 }
	}
} satisfies File)

describe("NotebookViewer", () => {
	beforeEach(() => {
		notebook.current = NOTEBOOK
	})

	it("shows the cells with their gutter, highlighted code and outputs, and the source a toggle away", async () => {
		const { container } = render(
			<NotebookViewer
				item={ITEM}
				alt="analysis.ipynb"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(await screen.findByText("In [7]:")).toBeTruthy()
		expect(screen.getByText("In [ ]:")).toBeTruthy()
		expect(screen.getByRole("heading", { name: "Analysis" })).toBeTruthy()
		expect(screen.getByText("printed line")).toBeTruthy()
		expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:https://app.example/figure")
		// Highlighted (near the viewport, on idle): the keyword is a span of its own with the editor's class.
		expect((await screen.findByText("def")).tagName).toBe("SPAN")
		expect(asked.current[0]).toBeGreaterThan(0)

		fireEvent.click(screen.getByRole("button", { name: "Source" }))

		expect(await screen.findByText(/"nbformat": 4|"nbformat":4/)).toBeTruthy()
	})

	it("counts its markdown cells' diagrams as one document's: the 51st waits to be asked", async () => {
		globalThis.IntersectionObserver = class {
			observe(): void {
				return undefined
			}

			unobserve(): void {
				return undefined
			}

			disconnect(): void {
				return undefined
			}
		} as unknown as typeof IntersectionObserver
		notebook.current = JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: {},
			cells: Array.from({ length: 51 }, (_, index) => ({
				cell_type: "markdown",
				metadata: {},
				source: `\`\`\`mermaid\ngraph TD; A${String(index)}-->B\n\`\`\``
			}))
		})

		render(
			<NotebookViewer
				item={ITEM}
				alt="analysis.ipynb"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(await screen.findAllByRole("button", { name: "Render diagram" })).toHaveLength(1)
		expect(document.querySelectorAll("iframe")).toHaveLength(0)
	})

	it("measures an HTML output's nearness against the notebook's scroller, sanitizes it once and keeps its height away", async () => {
		const intersections: Observed[] = []
		const resizes: { callback: (entries: { contentRect: { height: number } }[]) => void; targets: Element[] }[] = []

		vi.stubGlobal(
			"IntersectionObserver",
			class {
				readonly observed: Observed

				constructor(callback: Observed["callback"], options: { root?: Element | null }) {
					this.observed = { callback, root: options.root ?? null, targets: [] }
					intersections.push(this.observed)
				}

				observe(target: Element): void {
					this.observed.targets.push(target)
				}

				disconnect(): void {
					return undefined
				}
			}
		)
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly observed: (typeof resizes)[number]

				constructor(callback: (typeof resizes)[number]["callback"]) {
					this.observed = { callback, targets: [] }
					resizes.push(this.observed)
				}

				observe(target: Element): void {
					this.observed.targets.push(target)
				}

				disconnect(): void {
					return undefined
				}
			}
		)
		vi.mocked(sanitizeEmailHtml).mockClear()
		notebook.current = JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: {},
			cells: [
				{
					cell_type: "code",
					source: "df",
					execution_count: 1,
					metadata: {},
					outputs: [{ output_type: "display_data", data: { "text/html": "<table><tr><td>cell</td></tr></table>" }, metadata: {} }]
				}
			]
		})

		render(
			<NotebookViewer
				item={ITEM}
				alt="analysis.ipynb"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		await screen.findByText("In [1]:")

		const scroller = screen.getByRole("document", { name: "analysis.ipynb" })
		const output = intersections.find(observed => observed.targets.some(target => target.querySelector(".h-24") !== null))

		expect(intersections.length).toBeGreaterThan(0)
		// Every observer measures against the notebook's own scroller, never the page.
		expect(intersections.every(observed => observed.root === scroller)).toBe(true)
		expect(output).toBeDefined()

		const wrapper = output?.targets[0] as HTMLElement | undefined
		const content = wrapper?.firstElementChild as HTMLElement | null | undefined
		const sizing = resizes.find(observed => content !== null && content !== undefined && observed.targets.includes(content))
		const placeholderHeight = (): string | undefined => (content?.firstElementChild as HTMLElement | null | undefined)?.style.height

		expect(sizing).toBeDefined()

		act(() => {
			output?.callback([{ isIntersecting: true }])
		})

		const frame = document.querySelector("iframe")

		expect(frame).not.toBeNull()

		act(() => {
			// The frame sized itself to its document, then the content reports that height.
			if (frame !== null) frame.style.height = "600px"

			sizing?.callback([{ contentRect: { height: 640 } }])
			output?.callback([{ isIntersecting: false }])
		})

		expect(document.querySelectorAll("iframe")).toHaveLength(0)
		expect(placeholderHeight()).toBe("640px")

		act(() => {
			output?.callback([{ isIntersecting: true }])
		})

		expect(document.querySelectorAll("iframe")).toHaveLength(1)

		act(() => {
			// The remounted frame at the default iframe height, before its document loaded and measured.
			sizing?.callback([{ contentRect: { height: 150 } }])
		})

		// The wrapper keeps the remembered height while the frame settles, and a second leave still holds it.
		expect(wrapper?.style.minHeight).toBe("640px")

		act(() => {
			output?.callback([{ isIntersecting: false }])
		})

		expect(placeholderHeight()).toBe("640px")
		expect(wrapper?.style.minHeight).toBe("640px")
		expect(sanitizeEmailHtml).toHaveBeenCalledTimes(1)
	})
})
