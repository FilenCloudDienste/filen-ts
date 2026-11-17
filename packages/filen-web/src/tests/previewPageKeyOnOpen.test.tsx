// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { encodeTiff } from "@/tests/support/tiffBytes"

// The next-page key pressed straight after a document opens in the preview, focus still on the overlay itself: a PDF,
// and a multi-page TIFF in the same page column (the MuPDF read role, its document a stand-in pdf.js one here).

const { pdf, tiff, scrolled } = vi.hoisted(() => {
	const pages = new Map<number, unknown>()
	// The stand-in pdf.js document: three pages of 100 × 100.
	const document = {
		numPages: 3,
		getPage: (n: number) => Promise.resolve(pages.get(n)),
		getDestination: () => Promise.resolve(null),
		getPageIndex: () => Promise.resolve(0),
		getOutline: () => Promise.resolve(null),
		getMetadata: () => Promise.resolve({ info: {} })
	}

	// The TIFF head the byte reader gives, and the read role's reader.
	const tiff: { head: Uint8Array; openMupdfReader: ReturnType<typeof vi.fn> } = { head: new Uint8Array(0), openMupdfReader: vi.fn() }

	return { pdf: { pages, document }, tiff, scrolled: [] as Element[] }
})

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvGet: () => Promise.resolve(null),
	kvHas: () => Promise.resolve(false),
	kvEntriesJson: () => Promise.resolve([]),
	kvEntriesJsonInSlices: () => Promise.resolve([]),
	kvDeletePrefix: () => Promise.resolve(),
	kvDeleteIfAt: () => Promise.resolve([]),
	isMissingStorageMethod: () => false
}))
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFDataRangeTransport: vi.fn(),
	TextLayer: class {
		readonly textDivs: HTMLElement[] = []
		readonly textContentItemsStr: string[] = []

		render(): Promise<void> {
			return Promise.resolve()
		}

		cancel(): void {
			// Renders at once.
		}

		static cleanup(): void {
			// No measuring canvases.
		}
	},
	getDocument: () => ({ promise: Promise.resolve(pdf.document), destroy: () => Promise.resolve() })
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))
vi.mock("@/lib/mupdf/reader", () => ({ openMupdfReader: tiff.openMupdfReader, mupdfImagePixels: () => 30_000_000 }))
vi.mock("@/features/preview/lib/origin/byteReader", () => ({
	openByteReader: () => Promise.resolve({ size: tiff.head.length, read: () => Promise.resolve(tiff.head), close: () => undefined })
}))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const { PreviewOverlay } = await import("@/features/preview/components/previewOverlay")

registerAllActions()

class NoIntersectionObserver {
	observe(): void {
		// The test scrolls nothing.
	}

	unobserve(): void {
		// Nothing observed.
	}

	disconnect(): void {
		// Nothing observed.
	}
}

function page() {
	return {
		getViewport: vi.fn(() => ({ width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, y] })),
		render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
		cleanup: vi.fn(() => true),
		streamTextContent: () => [],
		getTextContent: () => Promise.resolve({ items: [] }),
		getAnnotations: vi.fn(() => Promise.resolve([])),
		userUnit: 1,
		rotate: 0
	}
}

function file(uuid: `${string}-${string}-${string}-${string}-${string}`, name: string, mime: string) {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
	})
}

beforeEach(() => {
	for (const n of [1, 2, 3]) {
		pdf.pages.set(n, page())
	}

	vi.stubGlobal("IntersectionObserver", NoIntersectionObserver)
	scrolled.length = 0
	// jsdom lays nothing out and has no scrollIntoView.
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: function (this: Element) {
			scrolled.push(this)
		}
	})
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

async function openAndPressN(item: ReturnType<typeof file>): Promise<void> {
	render(
		createElement(PreviewOverlay, {
			variant: "drive",
			items: [item],
			index: 0,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		}),
		{
			wrapper: queryClientWrapper(createTestQueryClient())
		}
	)
	await screen.findByText("Page 1 of 3")

	// The overlay takes focus as it opens; nothing in the viewer has it.
	const focused = await waitFor(() => {
		const element = document.activeElement

		expect(element?.getAttribute("role")).toBe("dialog")

		return element ?? document.body
	})

	expect(fireEvent.keyDown(focused, { key: "n", code: "KeyN" })).toBe(false)
	await waitFor(() => {
		expect(scrolled.at(-1)?.getAttribute("data-page")).toBe("2")
	})
}

describe("the next-page key straight after a document opens in the preview", () => {
	it("pages a PDF", async () => {
		await openAndPressN(file("11111111-1111-1111-1111-111111111111", "doc.pdf", "application/pdf"))
	})

	it("pages a multi-page TIFF", async () => {
		tiff.head = encodeTiff([
			{ width: 8, height: 8, rgb: [1, 2, 3] },
			{ width: 8, height: 8, rgb: [1, 2, 3] }
		])
		tiff.openMupdfReader.mockResolvedValue({ pageCount: 3, document: pdf.document, close: () => Promise.resolve() })
		await openAndPressN(file("33333333-3333-3333-3333-333333333333", "scan.tiff", "image/tiff"))
	})
})
