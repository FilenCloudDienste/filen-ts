// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// PdfPage's own lifecycle against a stand-in pdf.js: eviction must release the page's decoded
// resources, and a page reaching the render margin must not re-render its siblings.

interface FakePage {
	getViewport: ReturnType<typeof vi.fn>
	render: ReturnType<typeof vi.fn>
	cleanup: ReturnType<typeof vi.fn>
	streamTextContent: ReturnType<typeof vi.fn>
	getAnnotations: ReturnType<typeof vi.fn>
	userUnit: number
}

const { pages } = vi.hoisted(() => ({ pages: new Map<number, FakePage>() }))

function fakePage(): FakePage {
	return {
		getViewport: vi.fn(() => ({ width: 100, height: 100, convertToViewportPoint: (x: number, y: number) => [x, y] })),
		render: vi.fn(() => ({ promise: new Promise(() => undefined), cancel: vi.fn() })),
		cleanup: vi.fn(() => true),
		streamTextContent: vi.fn(() => ({})),
		getAnnotations: vi.fn(() => Promise.resolve([])),
		userUnit: 1
	}
}

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
	TextLayer: class {
		render(): Promise<void> {
			return Promise.resolve()
		}

		cancel(): void {
			// Nothing to cancel in the stand-in.
		}
	},
	getDocument: () => ({
		promise: Promise.resolve({
			numPages: 3,
			getPage: (n: number) => Promise.resolve(pages.get(n))
		}),
		destroy: () => Promise.resolve()
	})
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))

interface Observed {
	callback: IntersectionObserverCallback
	options: IntersectionObserverInit | undefined
	element: Element | null
}

const observers: Observed[] = []

class FakeIntersectionObserver {
	readonly entry: Observed

	constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.entry = { callback, options, element: null }
		observers.push(this.entry)
	}

	observe(element: Element): void {
		this.entry.element = element
	}

	disconnect(): void {
		// Observers are only ever driven by hand here.
	}
}

const { PdfViewer } = await import("@/features/preview/components/pdfViewer")

const item = linkedFileItem("doc.pdf", { uuid: "aaaaaaaa-0000-0000-0000-000000000001", mime: { Decrypted: "application/pdf" }, size: 1n })

// The render-margin observer asks for ratio thresholds; the eviction one does not.
function observerFor(pageNumber: number, kind: "render" | "evict"): Observed {
	const found = observers.find(observed => {
		const wrapper = observed.element
		const index = wrapper?.parentElement === null || wrapper === null ? -1 : Array.from(wrapper.parentElement.children).indexOf(wrapper)
		const isRender = Array.isArray(observed.options?.threshold)

		return index === pageNumber - 1 && isRender === (kind === "render")
	})

	if (found === undefined) {
		throw new Error(`no ${kind} observer for page ${String(pageNumber)}`)
	}

	return found
}

function fire(observed: Observed, isIntersecting: boolean, intersectionRatio = 0): void {
	act(() => {
		observed.callback([{ isIntersecting, intersectionRatio } as IntersectionObserverEntry], {} as IntersectionObserver)
	})
}

function page(n: number): FakePage {
	const found = pages.get(n)

	if (found === undefined) {
		throw new Error(`no page ${String(n)}`)
	}

	return found
}

beforeEach(() => {
	observers.length = 0
	pages.clear()

	for (const n of [1, 2, 3]) {
		pages.set(n, fakePage())
	}

	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
})

async function mount(): Promise<void> {
	render(
		<PdfViewer
			item={item}
			alt="doc.pdf"
		/>
	)

	await waitFor(() => {
		for (const n of [1, 2, 3]) {
			expect(page(n).getViewport).toHaveBeenCalled()
		}
	})
}

describe("PdfPage", () => {
	it("releases the page's decoded resources when it leaves the eviction margin", async () => {
		await mount()

		fire(observerFor(2, "evict"), true)
		expect(page(2).cleanup).not.toHaveBeenCalled()

		fire(observerFor(2, "evict"), false)
		expect(page(2).cleanup).toHaveBeenCalledTimes(1)
	})

	it("renders a page once it reaches the render margin, without re-rendering its siblings", async () => {
		await mount()

		fire(observerFor(2, "evict"), true)
		expect(page(2).render).not.toHaveBeenCalled()

		const siblingRenders = page(3).getViewport.mock.calls.length

		fire(observerFor(2, "render"), true)

		expect(page(2).render).toHaveBeenCalledTimes(1)
		expect(page(3).getViewport.mock.calls.length).toBe(siblingRenders)
	})
})
