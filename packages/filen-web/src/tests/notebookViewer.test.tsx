// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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

const { asked } = vi.hoisted(() => ({ asked: { current: [] as number[] } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([])
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode(NOTEBOOK), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	readNotebookFile: (text: string, maxPixels: number) => {
		asked.current.push(maxPixels)

		return Promise.resolve(readNotebook(text, maxPixels))
	}
}))

const { NotebookViewer } = await import("@/features/preview/components/notebookViewer")

registerAllActions()

beforeAll(() => {
	URL.createObjectURL = () => "blob:https://app.example/figure"
	URL.revokeObjectURL = () => undefined
})

afterEach(() => {
	cleanup()
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
		// Highlighted: the keyword is a span of its own with the editor's class.
		expect(screen.getByText("def").tagName).toBe("SPAN")
		expect(asked.current[0]).toBeGreaterThan(0)

		fireEvent.click(screen.getByRole("button", { name: "Source" }))

		expect(await screen.findByText(/"nbformat": 4|"nbformat":4/)).toBeTruthy()
	})
})
