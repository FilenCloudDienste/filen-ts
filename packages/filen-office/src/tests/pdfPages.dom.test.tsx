// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	PDF_PAGE_EVICT_MARGIN_PX,
	PDF_PAGE_RENDER_MARGIN_PX,
	PDF_ZOOM_RENDER_DELAY_MS,
	type PdfPage,
	type PdfRenderParams,
	type PdfViewport
} from "../dom/pdf/index"
import {
	paintMatches,
	PdfPages,
	usePdfDocument,
	usePdfViewer,
	type PdfDocumentHandle,
	type PdfDocumentOptions,
	type PdfDomDocument,
	type PdfJsDom,
	type PdfTextLayerParams,
	type PdfViewer
} from "../react/pdf/index"

// The headless pages and hooks against a stand-in pdf.js: one pair of observers for every page, the render gate
// and eviction, links through the shared policy, the password loop on one task, and find painted into the text
// layer.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

interface FakePage extends PdfPage<ReadableStream> {
	readonly render: ReturnType<typeof vi.fn<(params: PdfRenderParams) => { promise: Promise<void>; cancel: () => void }>>
	readonly cleanup: ReturnType<typeof vi.fn<() => boolean>>
	readonly getViewport: ReturnType<typeof vi.fn<(params: { scale: number; rotation?: number }) => PdfViewport>>
	readonly getAnnotations: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>
}

function textItems(text: readonly string[]): object[] {
	return text.map(str => ({ str, hasEOL: false }))
}

// A page 100 wide and `tall` high, turned by `rotation`.
function viewport(scale: number, rotation = 0, tall = 100): PdfViewport {
	const turned = rotation % 180 !== 0

	return {
		viewBox: [0, 0, 100, tall],
		userUnit: 1,
		scale,
		rotation,
		offsetX: 0,
		offsetY: 0,
		transform: [scale, 0, 0, -scale, 0, tall * scale],
		width: (turned ? tall : 100) * scale,
		height: (turned ? 100 : tall) * scale,
		rawDims: {},
		clone: () => viewport(scale, rotation, tall),
		convertToViewportPoint: (x: number, y: number) => [x, y],
		convertToPdfPoint: (x: number, y: number) => [x, y]
	}
}

function fakePage(text: readonly string[], annotations: unknown[] = [], tall = 100, rotate = 0): FakePage {
	return {
		userUnit: 1,
		rotate,
		getViewport: vi.fn(({ scale, rotation }: { scale: number; rotation?: number }) => viewport(scale, rotation ?? rotate, tall)),
		render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
		cleanup: vi.fn(() => true),
		// The stand-in text layer reads the items straight.
		streamTextContent: () => textItems(text) as unknown as ReadableStream,
		getTextContent: () => Promise.resolve({ items: textItems(text) }),
		getAnnotations: vi.fn(() => Promise.resolve(annotations))
	}
}

// Every text layer built, and every update() given to one.
const textLayers: FakeTextLayer[] = []

class FakeTextLayer {
	readonly textDivs: HTMLElement[] = []
	readonly textContentItemsStr: string[] = []
	readonly updates: PdfViewport[] = []
	private readonly params: PdfTextLayerParams

	constructor(params: PdfTextLayerParams) {
		this.params = params
		textLayers.push(this)
	}

	update({ viewport }: { viewport: PdfViewport }): void {
		this.updates.push(viewport)
	}

	render(): Promise<void> {
		for (const item of this.params.textContentSource as unknown as { str: string }[]) {
			const span = document.createElement("span")

			span.textContent = item.str
			this.textDivs.push(span)
			this.textContentItemsStr.push(item.str)
			this.params.container.append(span)
		}

		return Promise.resolve()
	}

	cancel(): void {
		// Renders synchronously.
	}
}

interface Opened {
	readonly params: unknown
	readonly destroy: ReturnType<typeof vi.fn>
	onPassword: unknown
	resolve: () => void
}

function fakePdfJs(
	pages: readonly FakePage[],
	destinations: Record<string, number> = {}
): { pdfjs: PdfJsDom; opened: Opened[]; document: PdfDomDocument } {
	const opened: Opened[] = []
	const document: PdfDomDocument = {
		numPages: pages.length,
		getPage: n => Promise.resolve(pages[n - 1] as FakePage),
		getDestination: id => Promise.resolve(id in destinations ? [{ page: destinations[id] }] : null),
		getPageIndex: ref => Promise.resolve((ref as { page: number }).page - 1),
		getOutline: () => Promise.resolve(null),
		getMetadata: () => Promise.resolve({ info: {} })
	}
	const pdfjs: PdfJsDom = {
		GlobalWorkerOptions: { workerSrc: "" },
		PDFDataRangeTransport: class {
			requestDataRange(): void {
				// Unused.
			}

			onDataRange(): void {
				// Unused.
			}

			abort(): void {
				// Unused.
			}
		},
		TextLayer: FakeTextLayer,
		getDocument(params) {
			let resolve: () => void = () => undefined
			const promise = new Promise<PdfDomDocument>(yes => {
				resolve = () => {
					yes(document)
				}
			})
			const task = { params, destroy: vi.fn(() => Promise.resolve()), onPassword: null as unknown, resolve, promise }

			opened.push(task)

			return task
		}
	}

	return { pdfjs, opened, document }
}

interface Observer {
	readonly callback: IntersectionObserverCallback
	readonly options: IntersectionObserverInit | undefined
	readonly elements: Set<Element>
}

const observers: Observer[] = []

class FakeIntersectionObserver {
	readonly entry: Observer

	constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.entry = { callback, options, elements: new Set() }
		observers.push(this.entry)
	}

	observe(element: Element): void {
		this.entry.elements.add(element)
	}

	unobserve(element: Element): void {
		this.entry.elements.delete(element)
	}

	disconnect(): void {
		this.entry.elements.clear()
	}
}

const scrolled: Element[] = []
const roots: Root[] = []
let host: HTMLDivElement
const latest: { document: PdfDocumentHandle | null; viewer: PdfViewer | null } = { document: null, viewer: null }

beforeEach(() => {
	observers.length = 0
	scrolled.length = 0
	textLayers.length = 0
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
	vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
		scrolled.push(this)
	})
	host = document.createElement("div")
	document.body.append(host)
})

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
	latest.document = null
	latest.viewer = null
})

const SOURCE = { kind: "bytes", bytes: new Uint8Array([1]) } as const
const OPTIONS: PdfDocumentOptions = { worker: { kind: "script", src: "/worker.mjs" } }

function Viewer({ pdfjs, document: pdf }: { pdfjs: PdfJsDom; document: PdfDomDocument }) {
	const viewer = usePdfViewer(pdf)

	latest.viewer = viewer

	return (
		<PdfPages
			pdfjs={pdfjs}
			{...viewer.pages}
			pageLabel={(page, total) => `Page ${String(page)} of ${String(total)}`}
			classNames={{ textLayer: "text-layer", link: "link", canvas: painted => (painted ? "painted" : "blank") }}
			placeholder={<i className="placeholder" />}
		/>
	)
}

function Harness({ pdfjs }: { pdfjs: PdfJsDom }) {
	const handle = usePdfDocument(pdfjs, SOURCE, OPTIONS)

	latest.document = handle

	return handle.state.status === "ready" ? (
		<Viewer
			pdfjs={pdfjs}
			document={handle.state.document}
		/>
	) : (
		<p data-status={handle.state.status} />
	)
}

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

async function mount(pdfjs: PdfJsDom, opened: Opened[]): Promise<void> {
	const root = createRoot(host)

	roots.push(root)
	act(() => {
		root.render(<Harness pdfjs={pdfjs} />)
	})
	opened[0]?.resolve()
	await settle()
}

function pageElement(page: number): HTMLElement {
	const element = host.querySelector<HTMLElement>(`[data-page="${String(page)}"]`)

	if (element === null) throw new Error(`no page ${String(page)}`)

	return element
}

function observer(kind: "render" | "evict"): Observer {
	const margin = `${String(kind === "render" ? PDF_PAGE_RENDER_MARGIN_PX : PDF_PAGE_EVICT_MARGIN_PX)}px 0px`
	const found = observers.find(entry => entry.options?.rootMargin === margin)

	if (found === undefined) throw new Error(`no ${kind} observer`)

	return found
}

function fire(kind: "render" | "evict", page: number, isIntersecting: boolean, intersectionRatio = isIntersecting ? 1 : 0): void {
	const entry = observer(kind)

	act(() => {
		entry.callback(
			[{ target: pageElement(page), isIntersecting, intersectionRatio } as unknown as IntersectionObserverEntry],
			{} as IntersectionObserver
		)
	})
}

async function show(page: number): Promise<void> {
	fire("evict", page, true)
	fire("render", page, true)
	await settle()
}

describe("PdfPages", () => {
	it("watches every page with one pair of observers", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage([]), fakePage([]), fakePage([])])

		await mount(pdfjs, opened)

		expect(observers).toHaveLength(2)
		expect(observer("render").elements.size).toBe(3)
		expect(observer("evict").elements.size).toBe(3)
	})

	it("renders a page once it nears the view, without re-rendering its siblings", async () => {
		const pages = [fakePage([]), fakePage([]), fakePage([])]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)

		const siblingViewports = pages[2]?.getViewport.mock.calls.length

		fire("evict", 2, true)
		expect(pages[1]?.render).not.toHaveBeenCalled()

		// Nearing the view without becoming the page most in view.
		fire("render", 2, true, 0)
		await settle()

		expect(pages[1]?.render).toHaveBeenCalledTimes(1)
		expect(pages[2]?.getViewport.mock.calls.length).toBe(siblingViewports)
		expect(pageElement(2).dataset["rendered"]).toBe("true")
	})

	it("releases a page's canvas, text layer and pdf.js resources once it is far from the view", async () => {
		const pages = [fakePage(["one"]), fakePage(["two"])]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)
		await show(2)

		const canvas = pageElement(2).querySelector("canvas")

		expect(pageElement(2).querySelector(".text-layer")?.textContent).toBe("two")

		fire("evict", 2, false)
		await settle()

		expect(pages[1]?.cleanup).toHaveBeenCalledTimes(1)
		expect(canvas?.width).toBe(0)
		expect(pageElement(2).querySelector(".text-layer")?.childElementCount).toBe(0)
		expect(pageElement(2).dataset["rendered"]).toBe("false")
	})

	it("renders allowed external links as new-tab anchors and drops the rest", async () => {
		const page = fakePage(
			[],
			[
				{ subtype: "Link", rect: [0, 0, 10, 10], url: "https://example.com/x" },
				{ subtype: "Link", rect: [0, 20, 10, 30], unsafeUrl: "javascript:alert(1)" }
			]
		)
		const { pdfjs, opened } = fakePdfJs([page])

		await mount(pdfjs, opened)
		await show(1)

		const links = pageElement(1).querySelectorAll("a")

		expect(links).toHaveLength(1)
		expect(links[0]?.getAttribute("href")).toBe("https://example.com/x")
		expect(links[0]?.getAttribute("target")).toBe("_blank")
		expect(links[0]?.getAttribute("rel")).toBe("noreferrer")
		expect(links[0]?.getAttribute("aria-label")).toBe("https://example.com/x")
		// The package's own classes (css/pdf.css positions the page and its links), joined with the host's.
		expect(pageElement(1).className).toBe("fo-pdf-page")
		expect(pageElement(1).querySelector(".fo-pdf-text-layer")?.classList.contains("text-layer")).toBe(true)
		expect(links[0]?.className).toBe("fo-pdf-link link")
	})

	it("follows an in-document link to the page its destination names", async () => {
		const first = fakePage([], [{ subtype: "Link", rect: [0, 0, 10, 10], dest: "chapter" }])
		const { pdfjs, opened } = fakePdfJs([first, fakePage([]), fakePage([])], { chapter: 3 })

		await mount(pdfjs, opened)
		await show(1)

		const link = pageElement(1).querySelector("a")

		expect(link?.getAttribute("aria-label")).toBe("Page 3 of 3")

		const click = new MouseEvent("click", { bubbles: true, cancelable: true })

		act(() => {
			link?.dispatchEvent(click)
		})

		expect(click.defaultPrevented).toBe(true)
		expect(scrolled).toEqual([pageElement(3)])
		// No href, so a middle click cannot open the host page in a new tab; Enter follows it as a link would.
		expect(link?.hasAttribute("href")).toBe(false)
		expect(link?.getAttribute("role")).toBe("link")

		act(() => {
			link?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
		})
		expect(scrolled).toEqual([pageElement(3), pageElement(3)])
	})

	it("puts a destination's point at the view's top at the current zoom and turn, and a newer navigation wins", async () => {
		const target = fakePage([], [], 200)

		// pdf.js's mapping for a 100 × 200 page at 0° and 90°.
		target.getViewport.mockImplementation(({ scale, rotation }) => ({
			...viewport(scale, rotation ?? 0, 200),
			convertToViewportPoint: (x: number, y: number) => (rotation === 90 ? [y * scale, x * scale] : [x * scale, (200 - y) * scale])
		}))

		const first = fakePage([], [{ subtype: "Link", rect: [0, 0, 10, 10], dest: [{ page: 2 }, { name: "XYZ" }, 20, 150, null] }])
		const { pdfjs, opened } = fakePdfJs([first, target])

		await mount(pdfjs, opened)
		await show(1)

		const scroller = host.firstElementChild as HTMLElement
		const scrollTo = vi.fn()
		const room = { width: 1000 }

		scroller.scrollTo = scrollTo as typeof scroller.scrollTo
		Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 40 })
		Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => room.width })
		vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 100, left: 0, width: 1000, height: 600 } as DOMRect)
		vi.spyOn(pageElement(2), "getBoundingClientRect").mockReturnValue({ top: 500, left: 30, width: 150, height: 300 } as DOMRect)

		act(() => {
			pageElement(1)
				.querySelector("a")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
		})
		await settle()
		// The page's top in the scroller (500 - 100 + 40) plus the point's depth ((200 - 150) × 1.5); the page is
		// narrower than the view, so it stays across where it is.
		expect(scrollTo).toHaveBeenLastCalledWith({ top: 515, behavior: "auto" })
		expect(scrolled).not.toContain(pageElement(2))

		act(() => {
			latest.viewer?.dispatch({ type: "rotate.clockwise" })
		})
		await settle()
		room.width = 100
		act(() => {
			latest.viewer?.dispatch({ type: "page.goto", page: 2, left: 20, top: 150 })
		})
		await settle()
		expect(target.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 90 })
		// Turned: the PDF left is the depth (20 × 1.5), the top runs across (150 × 1.5) on a page wider than the view.
		expect(scrollTo).toHaveBeenLastCalledWith({ top: 470, left: 255, behavior: expect.any(String) as unknown })

		const calls = scrollTo.mock.calls.length

		act(() => {
			latest.viewer?.dispatch({ type: "page.goto", page: 2, top: 150 })
			latest.viewer?.dispatch({ type: "page.goto", page: 1 })
		})
		await settle()
		expect(scrollTo).toHaveBeenCalledTimes(calls)
		expect(scrolled.at(-1)).toBe(pageElement(1))
	})

	it("zooms with Ctrl and the wheel, and leaves a plain wheel to scroll", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage([])])

		await mount(pdfjs, opened)

		const scroller = host.firstElementChild as HTMLElement
		const plain = new WheelEvent("wheel", { deltaY: -100, cancelable: true })
		const zoom = new WheelEvent("wheel", { deltaY: -100, cancelable: true })

		// happy-dom drops the modifier keys of a WheelEvent's init.
		Object.defineProperty(zoom, "ctrlKey", { value: true })

		act(() => {
			scroller.dispatchEvent(plain)
		})
		expect(latest.viewer?.state.zoom).toBe(100)

		act(() => {
			scroller.dispatchEvent(zoom)
		})
		expect(zoom.defaultPrevented).toBe(true)
		expect(latest.viewer?.state.zoom).toBe(110)
	})

	it("turns every page, its own /Rotate included, and paints the canvas and text layer again", async () => {
		const pages = [fakePage(["a"], [], 200), fakePage(["b"], [], 200, 90)]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)
		await show(1)
		// Read once it nears the view.
		await show(2)
		expect(pageElement(1).style.width).toBe("150px")
		expect(pageElement(1).style.height).toBe("300px")

		const renders = pages[0]?.render.mock.calls.length ?? 0

		act(() => {
			latest.viewer?.dispatch({ type: "rotate.clockwise" })
		})
		await settle()
		expect(latest.viewer?.state.rotation).toBe(90)
		expect(pageElement(1).style.width).toBe("300px")
		expect(pageElement(1).style.height).toBe("150px")
		expect(pages[0]?.render.mock.calls.length).toBe(renders + 1)
		expect(pages[0]?.render.mock.calls.at(-1)?.[0].viewport.rotation).toBe(90)
		expect(pages[0]?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 90 })
		// The page that turns itself by 90° ends up at 180°.
		expect(pages[1]?.getViewport).toHaveBeenLastCalledWith({ scale: 1.5, rotation: 180 })
		// The page in view stays in view.
		expect(scrolled.at(-1)).toBe(pageElement(1))

		act(() => {
			latest.viewer?.dispatch({ type: "rotate.counterClockwise" })
			latest.viewer?.dispatch({ type: "rotate.counterClockwise" })
		})
		await settle()
		expect(latest.viewer?.state.rotation).toBe(270)
	})

	it("fits the page in view to the width or whole, keeps fitting as the view resizes, and leaves it on a zoom", async () => {
		const resized: ResizeObserverCallback[] = []

		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: ResizeObserverCallback) {
					resized.push(callback)
				}

				observe(): void {
					// Resizes are fired by hand.
				}

				disconnect(): void {
					resized.length = 0
				}
			}
		)

		const { pdfjs, opened } = fakePdfJs([fakePage([], [], 200)])

		await mount(pdfjs, opened)

		const scroller = host.firstElementChild as HTMLElement
		const room = { width: 232, height: 432 }

		Object.defineProperty(scroller, "clientWidth", { get: () => room.width })
		Object.defineProperty(scroller, "clientHeight", { get: () => room.height })

		act(() => {
			latest.viewer?.dispatch({ type: "zoom.fitWidth" })
		})
		await settle()
		// (232 - 2 × 16) / 100
		expect(latest.viewer?.state.scale).toBe(2)
		expect(latest.viewer?.state.zoomMode).toBe("fitWidth")

		room.width = 132
		act(() => {
			for (const callback of resized) callback([], {} as ResizeObserver)
		})
		expect(latest.viewer?.state.scale).toBe(1)

		act(() => {
			latest.viewer?.dispatch({ type: "zoom.fitPage" })
		})
		await settle()
		// min((132 - 32) / 100, (432 - 32) / 200)
		expect(latest.viewer?.state.scale).toBe(1)
		room.width = 1032
		act(() => {
			for (const callback of resized) callback([], {} as ResizeObserver)
		})
		expect(latest.viewer?.state.scale).toBe(2)
		expect(latest.viewer?.state.zoomMode).toBe("fitPage")

		act(() => {
			latest.viewer?.dispatch({ type: "zoom.in" })
		})
		expect(latest.viewer?.state.zoomMode).toBe("custom")
		expect(resized).toHaveLength(0)
	})

	it("goes to the first and last page", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage([]), fakePage([]), fakePage([])])

		await mount(pdfjs, opened)
		act(() => {
			latest.viewer?.dispatch({ type: "page.last" })
		})
		expect(scrolled.at(-1)).toBe(pageElement(3))
		act(() => {
			latest.viewer?.dispatch({ type: "page.first" })
		})
		expect(scrolled.at(-1)).toBe(pageElement(1))
	})
})

async function pastZoomDelay(): Promise<void> {
	await act(() => new Promise(resolve => setTimeout(resolve, PDF_ZOOM_RENDER_DELAY_MS + 30)))
	await settle()
}

function zoomIn(times: number): void {
	act(() => {
		for (let step = 0; step < times; step++) latest.viewer?.dispatch({ type: "zoom.in" })
	})
}

describe("PdfPages loading and zooming", () => {
	it("reads only page 1 at open, sizes the unread pages from it, and reads a page once it nears the view", async () => {
		const pages = Array.from({ length: 50 }, () => fakePage([], [], 200))
		const { pdfjs, opened, document: pdf } = fakePdfJs(pages)
		const getPage = vi.spyOn(pdf, "getPage")

		await mount(pdfjs, opened)

		expect(new Set(getPage.mock.calls.map(([page]) => page))).toEqual(new Set([1]))
		// Page 1 at 150 %, turned with the view.
		expect(pageElement(30).style.width).toBe("150px")
		expect(pageElement(30).style.height).toBe("300px")

		await show(30)
		expect(getPage).toHaveBeenCalledWith(30)
		expect(pages[29]?.render).toHaveBeenCalledTimes(1)
		expect(new Set(getPage.mock.calls.map(([page]) => page))).toEqual(new Set([1, 30]))
	})

	it("names the page taking the most of the view, not a page inside the observers' margin", async () => {
		const scroll = { top: 0 }
		const rect = (top: number, height: number): DOMRect =>
			({ left: 0, top, width: 400, height, right: 400, bottom: top + height, x: 0, y: top }) as DOMRect

		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
		vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
			clearTimeout(frame)
		})
		// Pages stack 16 px apart below a 16 px gap in a 300 px tall view.
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			const page = Number((this as HTMLElement).dataset["page"] ?? 0)

			if (page === 0) return rect(0, 300)

			let top = 16 - scroll.top

			for (let previous = 1; previous < page; previous++) top += parseFloat(pageElement(previous).style.height) + 16

			return rect(top, parseFloat((this as HTMLElement).style.height))
		})

		const { pdfjs, opened } = fakePdfJs(Array.from({ length: 10 }, () => fakePage([])))

		await mount(pdfjs, opened)

		// 150 px pages: page 5 fills the view's top, page 6 its lower part; pages 1-4 sit above, pages 3 and 4
		// within the render margin, which reports them wholly intersecting.
		for (let page = 1; page <= 8; page++) fire("render", page, true, 1)

		scroll.top = 4 * 166
		host.firstElementChild?.dispatchEvent(new Event("scroll"))
		await settle()
		expect(latest.viewer?.state.page).toBe(5)

		scroll.top = 4 * 166 + 100
		host.firstElementChild?.dispatchEvent(new Event("scroll"))
		await settle()
		expect(latest.viewer?.state.page).toBe(6)
	})

	it("keeps a zoomed page's bitmap on screen, stretched, and renders the sharper one once the zoom steps pause", async () => {
		const drawImage = vi.fn()

		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)

		const pages = [fakePage(["a"])]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)
		await show(1)

		const canvas = pageElement(1).querySelector("canvas")

		expect(pages[0]?.render).toHaveBeenCalledTimes(1)
		expect(canvas?.className).toBe("painted")

		// A pinch's worth of steps: none restarts a render, and the old bitmap stays up at the new size.
		zoomIn(3)

		const scale = latest.viewer?.state.scale ?? 0

		expect(scale).toBeGreaterThan(1.5)
		expect(pageElement(1).dataset["rendered"]).toBe("false")
		expect(canvas?.className).toBe("painted")
		expect(pageElement(1).querySelector(".placeholder")).toBeNull()
		expect(canvas?.style.width).toBe(`${String(Math.floor(100 * scale))}px`)
		expect(canvas?.width).toBe(150)
		expect(pages[0]?.render).toHaveBeenCalledTimes(1)

		await pastZoomDelay()

		expect(pages[0]?.render).toHaveBeenCalledTimes(2)

		// Rendered offscreen, then copied over and released.
		const offscreen = pages[0]?.render.mock.calls[1]?.[0].canvas as HTMLCanvasElement

		expect(offscreen).not.toBe(canvas)
		expect(drawImage).toHaveBeenCalledWith(offscreen, 0, 0)
		expect(offscreen.width).toBe(0)
		expect(canvas?.width).toBe(Math.floor(100 * scale))
		expect(pageElement(1).dataset["rendered"]).toBe("true")
	})

	it("lays the text layer out again on a zoom or a turn instead of reading the page's text again", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage(["alpha ", "beta"])])

		await mount(pdfjs, opened)
		await show(1)
		expect(textLayers).toHaveLength(1)

		const spans = Array.from(pageElement(1).querySelectorAll(".text-layer span"))

		zoomIn(2)
		await pastZoomDelay()

		const scale = latest.viewer?.state.scale

		expect(textLayers).toHaveLength(1)
		expect(textLayers[0]?.updates.at(-1)?.scale).toBe(scale)
		// The same spans, so a selection and the find highlights survive.
		expect(Array.from(pageElement(1).querySelectorAll(".text-layer span"))).toEqual(spans)

		act(() => {
			latest.viewer?.dispatch({ type: "rotate.clockwise" })
		})
		await pastZoomDelay()
		expect(textLayers).toHaveLength(1)
		expect(textLayers[0]?.updates.at(-1)?.rotation).toBe(90)
	})

	it("ends each text layer in pdf.js's endOfContent block, which covers the layer and follows the selection", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage(["alpha ", "beta"])])

		await mount(pdfjs, opened)
		await show(1)

		const layer = pageElement(1).querySelector<HTMLElement>(".text-layer")
		const end = layer?.lastElementChild as HTMLElement
		const [first] = Array.from(layer?.querySelectorAll("span") ?? [])

		expect(end.className).toBe("endOfContent")

		layer?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
		expect(layer?.classList.contains("selecting")).toBe(true)

		// A drag that ends in the first span: the block moves right after it, so the gap past it selects nothing.
		const changes = vi.fn()

		document.addEventListener("selectionchange", changes)

		// happy-dom sends selectionchange itself, as a browser does.
		if (first !== undefined) document.getSelection()?.selectAllChildren(first)

		await settle()
		document.removeEventListener("selectionchange", changes)
		expect(changes).toHaveBeenCalledTimes(1)
		expect(layer?.classList.contains("selecting")).toBe(true)
		expect(end.previousSibling).toBe(first)
		expect(end.style.userSelect).toBe("text")

		document.dispatchEvent(new Event("pointerup"))
		expect(layer?.classList.contains("selecting")).toBe(false)
		expect(layer?.lastElementChild).toBe(end)
		expect(end.style.userSelect).toBe("")

		// Torn down with the layer.
		fire("evict", 1, false)
		await settle()
		expect(layer?.querySelector(".endOfContent")).toBeNull()
	})
})

describe("usePdfDocument", () => {
	it("asks for the password on the same task until it opens, and destroys the task on unmount", async () => {
		const { pdfjs, opened } = fakePdfJs([fakePage([])])
		const root = createRoot(host)

		act(() => {
			root.render(<Harness pdfjs={pdfjs} />)
		})

		const task = opened[0]
		const update = vi.fn()
		const onPassword = task?.onPassword as (update: (password: string) => void, reason: number) => void

		act(() => {
			onPassword(update, 1)
		})
		expect(latest.document?.state).toEqual({ status: "password", reason: "required" })

		act(() => {
			latest.document?.password("wrong")
		})
		expect(update).toHaveBeenCalledWith("wrong")
		expect(latest.document?.state.status).toBe("loading")

		act(() => {
			onPassword(update, 2)
		})
		expect(latest.document?.state).toEqual({ status: "password", reason: "incorrect" })

		act(() => {
			latest.document?.password("right")
		})
		task?.resolve()
		await settle()

		expect(latest.document?.state.status).toBe("ready")
		expect(opened).toHaveLength(1)

		act(() => {
			root.unmount()
		})
		expect(task?.destroy).toHaveBeenCalledTimes(1)
	})
})

describe("usePdfDocument sources", () => {
	function Rebuilt({ pdfjs, bytes }: { pdfjs: PdfJsDom; bytes: Uint8Array }) {
		latest.document = usePdfDocument(pdfjs, { kind: "bytes", bytes }, { worker: { kind: "script", src: "/worker.mjs" } })

		return null
	}

	it("keeps the document open when the host passes an equal source and options again, and opens a new one", () => {
		const { pdfjs, opened } = fakePdfJs([fakePage([])])
		const root = createRoot(host)
		const bytes = new Uint8Array([1])

		roots.push(root)
		act(() => {
			root.render(
				<Rebuilt
					pdfjs={pdfjs}
					bytes={bytes}
				/>
			)
		})
		act(() => {
			root.render(
				<Rebuilt
					pdfjs={pdfjs}
					bytes={bytes}
				/>
			)
		})
		expect(opened).toHaveLength(1)

		act(() => {
			root.render(
				<Rebuilt
					pdfjs={pdfjs}
					bytes={new Uint8Array([2])}
				/>
			)
		})
		expect(opened).toHaveLength(2)
		expect(opened[0]?.destroy).toHaveBeenCalledTimes(1)
		expect(latest.document?.state.status).toBe("loading")
	})
})

describe("find", () => {
	it("paints the matches into the text layer and moves the current one", async () => {
		const pages = [fakePage(["alpha ", "beta"]), fakePage(["beta gamma"])]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)
		await show(1)
		await show(2)

		act(() => {
			latest.viewer?.dispatch({ type: "find.open" })
			latest.viewer?.dispatch({ type: "find.query", query: "beta" })
		})
		await settle()

		expect(latest.viewer?.state.find).toMatchObject({ open: true, query: "beta", done: true, count: 2, active: 0 })

		const selected = (): string[] =>
			Array.from(
				host.querySelectorAll(".highlight.selected"),
				element => element.closest("[data-page]")?.getAttribute("data-page") ?? ""
			)

		expect(host.querySelectorAll(".highlight")).toHaveLength(2)
		expect(selected()).toEqual(["1"])
		expect(scrolled.at(-1)?.className).toContain("selected")

		act(() => {
			latest.viewer?.dispatch({ type: "find.next" })
		})
		await settle()
		expect(selected()).toEqual(["2"])

		act(() => {
			latest.viewer?.dispatch({ type: "find.close" })
		})
		await settle()
		expect(host.querySelectorAll(".highlight")).toHaveLength(0)
		expect(pageElement(1).querySelector(".text-layer")?.textContent).toBe("alpha beta")
	})

	it("brings the page of a match into view when its text is not shown yet", async () => {
		const pages = [fakePage(["nothing"]), fakePage(["filler"]), fakePage(["needle"])]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)

		act(() => {
			latest.viewer?.dispatch({ type: "find.query", query: "needle" })
		})
		await settle()

		expect(scrolled).toEqual([pageElement(3)])

		await show(3)
		expect(scrolled.at(-1)?.textContent).toBe("needle")
	})
})

describe("paintMatches", () => {
	it("marks a match over several spans begin, middle and end, and puts the text back", () => {
		const divs = ["ab", "cd", "ef"].map(text => {
			const span = document.createElement("span")

			span.textContent = text

			return span
		})
		const strs = ["ab", "cd", "ef"]
		const painted = paintMatches(divs, strs, Int32Array.from([1, 0, 1, 2, 1]), 0, 1, 0)

		expect(divs.map(div => div.innerHTML)).toEqual([
			'a<span class="highlight begin selected appended">b</span>',
			'<span class="highlight middle selected appended">cd</span>',
			'<span class="highlight end selected appended">e</span>f'
		])
		expect(painted.selected?.textContent).toBe("b")

		painted.restore()
		expect(divs.map(div => div.innerHTML)).toEqual(strs)
	})

	it("paints two matches in one span", () => {
		const div = document.createElement("span")

		div.textContent = "xaxax"

		paintMatches([div], ["xaxax"], Int32Array.from([1, 0, 1, 0, 2, 1, 0, 3, 0, 4]), 0, 2, 1)

		expect(div.innerHTML).toBe('x<span class="highlight appended">a</span>x<span class="highlight selected appended">a</span>x')
	})
})

// A laid-out column for the hooks that measure it: the scroller is `width` × `height` at (0, 0); pages stack 16 px
// apart below a 16 px gap at their styled size, centred across, moved by the scroller's own scroll position.
function stubLayout(width: number, height: number): { top: number; left: number } {
	const scroll = { top: 0, left: 0 }
	const isScroller = (element: Element): boolean => element === host.firstElementChild
	const rect = (left: number, top: number, w: number, h: number): DOMRect =>
		({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top }) as DOMRect

	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
	vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
		clearTimeout(frame)
	})
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width)
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height)
	vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
		return isScroller(this) ? scroll.top : 0
	})
	vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
		if (isScroller(this)) scroll.top = Math.max(0, value)
	})
	vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(function (this: Element) {
		return isScroller(this) ? scroll.left : 0
	})
	vi.spyOn(Element.prototype, "scrollLeft", "set").mockImplementation(function (this: Element, value: number) {
		if (isScroller(this)) scroll.left = Math.max(0, value)
	})
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		if (isScroller(this)) return rect(0, 0, width, height)

		const page = Number((this as HTMLElement).dataset["page"] ?? 0)
		let top = 16 - scroll.top

		for (let previous = 1; previous < page; previous++) top += parseFloat(pageElement(previous).style.height) + 16

		if (page === 0) return rect(0, 0, 0, 0)

		const w = parseFloat((this as HTMLElement).style.width)

		return rect(Math.max(0, (width - w) / 2) - scroll.left, top, w, parseFloat((this as HTMLElement).style.height))
	})

	return scroll
}

// The page under a point of the view, and how far down it the point lies.
function pointAt(viewY: number): { page: number; fy: number } {
	for (let page = 1; ; page++) {
		const box = pageElement(page).getBoundingClientRect()

		if (box.bottom > viewY || host.querySelector(`[data-page="${String(page + 1)}"]`) === null) {
			return { page, fy: (viewY - box.top) / box.height }
		}
	}
}

describe("usePdfViewer zoom anchor", () => {
	it("keeps the view's centre on a button zoom and the pointer's point on a Ctrl+wheel zoom", async () => {
		const scroll = stubLayout(400, 300)
		const { pdfjs, opened } = fakePdfJs([fakePage([], [], 200), fakePage([], [], 200), fakePage([], [], 200)])

		await mount(pdfjs, opened)

		const scroller = host.firstElementChild as HTMLElement

		// Mid-way down page 2 (300 px tall at 100 %).
		scroll.top = 400

		const centre = pointAt(150)

		act(() => {
			latest.viewer?.dispatch({ type: "zoom.in" })
		})
		expect(latest.viewer?.state.zoom).toBe(125)
		expect(pointAt(150).page).toBe(centre.page)
		expect(pointAt(150).fy).toBeCloseTo(centre.fy, 6)

		const pointer = pointAt(40)
		const wheel = new WheelEvent("wheel", { deltaY: -100, cancelable: true })

		// happy-dom drops a WheelEvent's modifier keys and position from its init.
		Object.defineProperty(wheel, "ctrlKey", { value: true })
		Object.defineProperty(wheel, "clientX", { value: 200 })
		Object.defineProperty(wheel, "clientY", { value: 40 })
		act(() => {
			scroller.dispatchEvent(wheel)
		})
		expect(latest.viewer?.state.zoom).toBe(135)
		expect(pointAt(40).page).toBe(pointer.page)
		expect(pointAt(40).fy).toBeCloseTo(pointer.fy, 6)

		const before = pointAt(150)

		act(() => {
			latest.viewer?.dispatch({ type: "zoom.set", scale: 3 })
		})
		expect(pointAt(150).fy).toBeCloseTo(before.fy, 6)
		expect(scrolled).toHaveLength(0)
	})
})

describe("usePdfViewer opening zoom", () => {
	it("opens a portrait page fitted to a narrow view's width, shown as a custom percent", async () => {
		stubLayout(132, 600)

		const { pdfjs, opened } = fakePdfJs([fakePage([], [], 200)])

		await mount(pdfjs, opened)
		// (132 - 32) / 100
		expect(latest.viewer?.state.scale).toBe(1)
		expect(latest.viewer?.state.zoom).toBe(67)
		expect(latest.viewer?.state.zoomMode).toBe("custom")
	})

	it("opens a landscape page whole, and at 100 % in a wide view", async () => {
		stubLayout(232, 82)

		const landscape = fakePdfJs([fakePage([], [], 50)])

		await mount(landscape.pdfjs, landscape.opened)
		// min((232 - 32) / 100, (82 - 32) / 50)
		expect(latest.viewer?.state.scale).toBe(1)
	})

	it("never opens past 100 %", async () => {
		stubLayout(2000, 2000)

		const { pdfjs, opened } = fakePdfJs([fakePage([], [], 200)])

		await mount(pdfjs, opened)
		expect(latest.viewer?.state.zoom).toBe(100)
	})
})

describe("usePdfViewer page steps", () => {
	it("steps each Next from the last target while the scroll runs, and from the page in view once it settles", async () => {
		const scroll = stubLayout(400, 300)
		const pages = [fakePage([], [], 200), fakePage([], [], 200), fakePage([], [], 200), fakePage([], [], 200)]
		const { pdfjs, opened } = fakePdfJs(pages)

		await mount(pdfjs, opened)

		const scroller = host.firstElementChild as HTMLElement

		act(() => {
			latest.viewer?.dispatch({ type: "page.next" })
			latest.viewer?.dispatch({ type: "page.next" })
		})
		expect(scrolled).toEqual([pageElement(2), pageElement(3)])

		// The scroll reaches page 3: the target is met.
		scroll.top = 632
		scroller.dispatchEvent(new Event("scroll"))
		await settle()
		expect(latest.viewer?.state.page).toBe(3)

		// Scrolled back by keyboard, which reports no pointer or wheel: the page in view counts again.
		scroll.top = 0
		scroller.dispatchEvent(new Event("scroll"))
		await settle()
		expect(latest.viewer?.state.page).toBe(1)
		act(() => {
			latest.viewer?.dispatch({ type: "page.next" })
		})
		expect(scrolled.at(-1)).toBe(pageElement(2))

		// The user grabbing the scroller drops the pending target.
		act(() => {
			latest.viewer?.dispatch({ type: "page.next" })
		})
		expect(scrolled.at(-1)).toBe(pageElement(3))
		scroller.dispatchEvent(new Event("pointerdown"))
		act(() => {
			latest.viewer?.dispatch({ type: "page.next" })
		})
		expect(scrolled.at(-1)).toBe(pageElement(2))
	})
})
