// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FontFaceDescriptor, FontHost } from "@filen/office/core/fonts"
import { bytesSource } from "@filen/office/core/opc"
import {
	DOCX_VIEWER_CAPABILITIES,
	isDocxCommandEnabled,
	parseDocxViewerCommand,
	stepZoom,
	fitWidthZoom,
	type DocxEvent,
	type DocxHost,
	type DocxListener,
	type DocxPageData,
	type DocxSessionApi,
	type DocxTextStyle,
	type DocxViewerState
} from "@filen/office/dom/docx"
import {
	DocxDocumentStore,
	DocxMediaCache,
	DocxPages,
	findInDocument,
	linkActivator,
	paintPage,
	useDocxDocument,
	useDocxViewer,
	type DocxDocument,
	type DocxViewer,
	type DocxSource,
	type DocxTables
} from "@filen/office/react/docx"
import { classicScrollbars } from "./scrollbars.dom"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const STYLE: DocxTextStyle = {
	font: '400 16px "fo1a2b-carlito", sans-serif',
	smallCapsFont: '400 11.2px "fo1a2b-carlito", sans-serif',
	color: "C00000",
	kerning: true,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	ascent: 12,
	descent: 4,
	revision: 0
}

// A page with one line per text: fragments cover each text whole.
function page(index: number, texts: readonly string[], links: readonly number[] = []): DocxPageData {
	const lineFloats: number[] = []
	const lineInts: number[] = []
	const fragmentFloats: number[] = []
	const fragmentInts: number[] = []

	texts.forEach((text, line) => {
		lineFloats.push(96 + line * 20, 20, 112 + line * 20, 96, text.length * 8)
		lineInts.push(line, 1, 0, text.length, 1 | 256, line, 0)
		fragmentFloats.push(96, text.length * 8, 0, 0)
		fragmentInts.push(0, text.length, 0, 0, 0)
	})

	return {
		index,
		number: index + 1,
		numberText: String(index + 1),
		section: 0,
		width: 816,
		height: 1056,
		lineCount: texts.length,
		fragmentCount: texts.length,
		decorationCount: 0,
		lineFloats: Float32Array.from(lineFloats),
		lineInts: Int32Array.from(lineInts),
		fragmentFloats: Float32Array.from(fragmentFloats),
		fragmentInts: Int32Array.from(fragmentInts),
		decorationFloats: new Float32Array(0),
		decorationInts: new Int32Array(0),
		graphicCount: 0,
		graphicFloats: new Float32Array(0),
		graphicInts: new Int32Array(0),
		objectCount: 0,
		objectFloats: new Float32Array(0),
		objectInts: new Int32Array(0),
		objectKinds: new Uint8Array(0),
		sourceCount: texts.length,
		sourceInts: Int32Array.from(texts.flatMap((_, line) => [0, 0, line, 0])),
		sourceTexts: texts,
		linkCount: links.length / 4,
		linkInts: Int32Array.from(links)
	}
}

const TABLES: DocxTables = {
	styles: [STYLE],
	decorations: [],
	links: [
		{ kind: "external", href: "https://example.com", tooltip: "Example" },
		{ kind: "internal", anchor: "target", tooltip: undefined }
	]
}

describe("paintPage", () => {
	it("draws text as positioned spans with validated styles and marks links", () => {
		const painted = paintPage(page(0, ["Hello <b>world</b>", "second"], [0, 0, 5, 0, 1, 0, 6, 1]), { document, tables: TABLES })
		const spans = painted.root.querySelectorAll<HTMLElement>(".fo-docx-run")

		expect(spans).toHaveLength(2)
		expect(spans[0]?.textContent).toBe("Hello <b>world</b>")
		expect(painted.root.querySelector("b")).toBeNull()
		expect(spans[0]?.style.left).toBe("96px")
		// Baseline 112 minus the font's ascent 12, inside its line's group at the line's top (96).
		expect(spans[0]?.parentElement?.style.top).toBe("96px")
		expect(spans[0]?.style.top).toBe("4px")
		expect(spans[0]?.style.lineHeight).toBe("16px")
		expect(spans[0]?.style.color).toMatch(/^(#c00000|rgb\(192, 0, 0\))$/i)
		// A link over part of a fragment is an inline child; over all of it, the span itself.
		const partial = spans[0]?.querySelector<HTMLElement>("[data-fo-link]")

		expect(partial?.textContent).toBe("Hello")
		expect(partial?.dataset["foLink"]).toBe("0")
		expect(partial?.getAttribute("role")).toBe("link")
		expect(partial?.title).toBe("Example")
		expect(spans[0]?.dataset["foLink"]).toBeUndefined()
		expect(spans[1]?.dataset["foLink"]).toBe("1")
		expect(painted.texts.map(text => [text.source, text.start, text.end])).toEqual([
			[0, 0, 18],
			[1, 0, 6]
		])
		// Paragraph ends copy as line breaks.
		expect(painted.root.querySelectorAll(".fo-docx-eol")).toHaveLength(2)
	})

	it("copies a soft-wrapped paragraph with its spaces and keeps logical order for right-to-left runs", () => {
		const text = "abc def ghi"
		const data = page(0, [text])
		// Two lines of one paragraph: "abc " | "def ghi" (the second line a reversed right-to-left pair).
		const wrapped: DocxPageData = {
			...data,
			lineCount: 2,
			fragmentCount: 3,
			lineFloats: Float32Array.from([96, 20, 112, 96, 32, 116, 20, 132, 96, 56]),
			lineInts: Int32Array.from([0, 1, 0, 4, 0, 0, 0, 1, 2, 4, 11, 1 | 128, 0, 0]),
			fragmentFloats: Float32Array.from([96, 32, 0, 0, 96, 24, 0, 0, 128, 24, 0, 0]),
			fragmentInts: Int32Array.from([0, 3, 0, 0, 0, 8, 11, 0, 1 << 8, 0, 4, 7, 0, 1 << 8, 0])
		}
		const painted = paintPage(wrapped, { document, tables: TABLES })
		const order = Array.from(painted.root.querySelectorAll(".fo-docx-text > .fo-docx-line > span"), span => span.textContent)

		expect(order).toEqual(["abc", " ", "def", "ghi", "\n"])
		expect(painted.texts.map(item => item.start)).toEqual([0, 4, 8])
	})

	it("never lets a style value through that is not what the engine produces", () => {
		const hostile: DocxTextStyle = { ...STYLE, font: '400 16px "x"; background:url(https://evil.test)', color: "red;x:y" }
		const painted = paintPage(page(0, ["text"]), { document, tables: { ...TABLES, styles: [hostile] } })
		const span = painted.root.querySelector<HTMLElement>(".fo-docx-run")

		expect(span?.getAttribute("style") ?? "").not.toContain("evil")
		expect(span?.getAttribute("style") ?? "").not.toContain("red")
		expect(span?.style.font).toContain("serif")
	})
})

describe("DocxMediaCache", () => {
	function session(media: Map<string, Uint8Array>): DocxSessionApi {
		return {
			objects: () => Promise.resolve([]),
			media: partName => {
				const bytes = media.get(partName)

				return Promise.resolve(bytes === undefined ? null : { bytes, type: "image/png" })
			},
			locate: () => Promise.resolve(null),
			find: () => Promise.resolve(new Int32Array(0)),
			close: () => undefined
		}
	}

	it("does not remember a failed read: a later page asks again", async () => {
		const media = new Map<string, Uint8Array>()
		const cache = new DocxMediaCache(
			session(media),
			{ maxBytes: 1000, maxEntries: 10 },
			{ create: () => "blob:test/1", revoke: () => undefined }
		)

		expect(await cache.acquire("late.png", "image/png")).toBeUndefined()
		media.set("late.png", new Uint8Array(4))
		expect(await cache.acquire("late.png", "image/png")).toBe("blob:test/1")
	})

	it("shares URLs, keeps those in use and revokes the rest over budget and on dispose", async () => {
		const created: string[] = []
		const revoked: string[] = []
		const urls = {
			create: (_bytes: Uint8Array, type: string) => {
				const url = `blob:test/${created.length}-${type}`

				created.push(url)

				return url
			},
			revoke: (url: string) => {
				revoked.push(url)
			}
		}
		const media = new Map([
			["a.png", new Uint8Array(600)],
			["b.png", new Uint8Array(600)]
		])
		const cache = new DocxMediaCache(session(media), { maxBytes: 1000, maxEntries: 10 }, urls)
		const a1 = await cache.acquire("a.png", "image/png")
		const a2 = await cache.acquire("a.png", "image/png")

		expect(a1).toBe(a2)
		expect(created).toHaveLength(1)
		expect(await cache.acquire("missing.png", "image/png")).toBeUndefined()
		expect(await cache.acquire("a.png", "")).toBeUndefined()

		// Over budget, but a is in use: nothing is revoked.
		await cache.acquire("b.png", "image/png")
		expect(revoked).toEqual([])

		cache.release("a.png", "image/png")
		cache.release("a.png", "image/png")
		expect(revoked).toEqual([a1])

		cache.dispose()
		expect(revoked).toHaveLength(2)
	})
})

// A host whose events the test sends by hand.
function manualHost(): { host: DocxHost; emit: (event: DocxEvent) => void; closed: () => boolean; session: DocxSessionApi } {
	let listener: DocxListener = () => undefined
	let closed = false
	const session: DocxSessionApi = {
		objects: () => Promise.resolve([]),
		media: () => Promise.resolve(null),
		locate: vi.fn(() => Promise.resolve({ page: 1, y: 10 })),
		find: vi.fn(() => Promise.resolve(Int32Array.from([0, 0, 0, 4]))),
		close: () => {
			closed = true
		}
	}

	return {
		host: (_source, onEvent) => {
			listener = onEvent

			return session
		},
		emit: event => listener(event),
		closed: () => closed,
		session
	}
}

// `tables`: the batch carries the style and link tables (the first batch of a document does).
function pagesEvent(pages: readonly DocxPageData[], final: boolean, tables = true): DocxEvent {
	return {
		type: "pages",
		pages,
		styles: tables ? [STYLE] : [],
		decorations: [],
		links: tables ? TABLES.links : [],
		final,
		pageCount: pages.length
	}
}

const flush = (): Promise<void> => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

describe("useDocxDocument and DocxPages", () => {
	let container: HTMLDivElement
	let root: Root

	beforeEach(() => {
		container = document.createElement("div")
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
	})

	function Probe({ source, onDocument }: { source: DocxSource; onDocument: (document: DocxDocument) => void }) {
		const document = useDocxDocument(source)

		onDocument(document)

		return (
			<DocxPages
				document={document}
				zoom={1}
				overscan={1}
				pageLabel={(index, count) => `Page ${index + 1} of ${count}`}
				onLinkActivate={linkActivator({ allow: href => href.startsWith("https:"), open: opened })}
			/>
		)
	}

	const opened = vi.fn<(href: string) => void>()

	it("goes from loading through streaming to ready, mounting only the pages in view", async () => {
		const manual = manualHost()
		const source: DocxSource = { host: manual.host, bytes: bytesSource(new Uint8Array(1)) }
		let latest: DocxDocument | undefined

		act(() =>
			root.render(
				<Probe
					source={source}
					onDocument={document => (latest = document)}
				/>
			)
		)
		expect(latest?.status).toBe("loading")

		manual.emit({
			type: "opened",
			info: { variant: "docx", gate: [], estimatedPages: 40, pageWidth: 816, pageHeight: 1056, mainPartBytes: 1000 }
		})
		const pages = Array.from({ length: 30 }, (_, index) => page(index, [`Page text ${index}`], [0, 0, 4, 0]))

		manual.emit(pagesEvent(pages.slice(0, 10), false))
		await flush()
		expect(latest?.status).toBe("streaming")
		expect(latest?.pageCount).toBe(40)

		manual.emit(pagesEvent(pages, true, false))
		await flush()
		expect(latest?.status).toBe("ready")
		expect(latest?.pageCount).toBe(30)

		const mounted = container.querySelectorAll(".fo-docx-page:not([data-fo-pending])")

		expect(mounted.length).toBeGreaterThan(0)
		expect(mounted.length).toBeLessThan(5)
		expect(container.querySelector(".fo-docx-pages-content")?.getAttribute("style")).toContain("height")
	})

	it("keeps an aside free right of the pages and draws an overlay over the mounted ones", async () => {
		const manual = manualHost()
		const source: DocxSource = { host: manual.host, bytes: bytesSource(new Uint8Array(1)) }
		const frames: { index: number; left: number; width: number }[][] = []

		function Aside() {
			const document = useDocxDocument(source)

			return (
				<DocxPages
					document={document}
					zoom={1}
					overscan={0}
					asideWidth={300}
					pageLabel={index => `Page ${index + 1}`}
					overlay={mounted => {
						frames.push(mounted.map(frame => ({ index: frame.index, left: frame.left, width: frame.width })))

						return <div className="probe-overlay" />
					}}
				/>
			)
		}

		act(() => root.render(<Aside />))
		manual.emit({
			type: "opened",
			info: { variant: "docx", gate: [], estimatedPages: 1, pageWidth: 816, pageHeight: 1056, mainPartBytes: 1000 }
		})
		manual.emit(pagesEvent([page(0, ["Text"], [0, 0, 4, 0])], true, false))
		await flush()

		const last = frames[frames.length - 1]

		expect(last?.map(frame => frame.index)).toEqual([0])
		// The content is as wide as the page, its gaps and the aside; the page keeps to the left of the aside.
		expect(container.querySelector<HTMLElement>(".fo-docx-pages-content")?.style.width).toBe(`${816 + 2 * 16 + 300}px`)
		expect(last?.[0]?.left).toBe(16)
		expect(container.querySelector(".fo-docx-pages-content .probe-overlay")).not.toBeNull()
	})

	it("centres the pages in the width a scrollbar the arriving pages bring leaves, in the commit that brings it", async () => {
		const manual = manualHost()
		const source: DocxSource = { host: manual.host, bytes: bytesSource(new Uint8Array(1)) }
		const size = { width: 1600, height: 900, scrollbar: 10 }
		const restore = classicScrollbars(size)

		function View() {
			const document = useDocxDocument(source)

			return (
				<DocxPages
					document={document}
					zoom={1}
					pageLabel={index => `Page ${index + 1}`}
				/>
			)
		}

		try {
			act(() => root.render(<View />))
			manual.emit({
				type: "opened",
				info: { variant: "docx", gate: [], estimatedPages: 1, pageWidth: 816, pageHeight: 1056, mainPartBytes: 1000 }
			})
			manual.emit(pagesEvent([page(0, ["Text"], [0, 0, 4, 0])], true, false))
			await flush()

			expect(container.querySelector<HTMLElement>(".fo-docx-page")?.style.left).toBe(`${((1600 - 10 - 816) / 2) | 0}px`)
		} finally {
			restore()
		}
	})

	it("opens external links through the policy and scrolls to internal ones", async () => {
		const manual = manualHost()
		const source: DocxSource = { host: manual.host, bytes: bytesSource(new Uint8Array(1)) }

		act(() =>
			root.render(
				<Probe
					source={source}
					onDocument={() => undefined}
				/>
			)
		)
		manual.emit(pagesEvent([page(0, ["external", "internal"], [0, 0, 8, 0, 1, 0, 8, 1])], true))
		await flush()

		const links = container.querySelectorAll<HTMLElement>("[data-fo-link]")

		act(() => links[0]?.click())
		expect(opened).toHaveBeenCalledWith("https://example.com")

		act(() => links[1]?.click())
		expect(manual.session.locate).toHaveBeenCalledWith("target")
	})

	it("keeps find results when the same query is sent again", async () => {
		const manual = manualHost()
		const source: DocxSource = { host: manual.host, bytes: bytesSource(new Uint8Array(1)) }
		let viewer: DocxViewer | undefined

		function Viewer() {
			const document = useDocxDocument(source)

			viewer = useDocxViewer(document)

			return null
		}

		act(() => root.render(<Viewer />))
		manual.emit(pagesEvent([page(0, ["text text"])], true))
		await flush()

		act(() => viewer?.dispatch({ type: "find.query", query: "text" }))
		await flush()
		expect(viewer?.state.find.count).toBe(1)

		act(() => viewer?.dispatch({ type: "find.query", query: "text" }))
		await flush()
		expect(viewer?.state.find.count).toBe(1)
		expect(viewer?.state.find.active).toBe(0)
	})

	it("reports engine errors and closes the session, and closes it on unmount", async () => {
		const manual = manualHost()
		let latest: DocxDocument | undefined

		act(() =>
			root.render(
				<Probe
					source={{ host: manual.host, bytes: bytesSource(new Uint8Array(1)) }}
					onDocument={document => (latest = document)}
				/>
			)
		)
		manual.emit({ type: "error", reason: "encrypted", message: "password" })
		await flush()
		expect(latest?.status).toBe("error")
		expect(latest?.error?.reason).toBe("encrypted")
		expect(manual.closed()).toBe(true)
	})

	it("registers replayed fonts before showing pages and removes them when the document closes", async () => {
		const manual = manualHost()
		const added: FontFaceDescriptor[] = []
		const removed: string[] = []
		let release: () => void = () => undefined
		const fontHost: FontHost = {
			addBytes: face => {
				added.push(face)

				return new Promise(resolve => {
					release = () => resolve(true)
				})
			},
			addLocal: () => Promise.resolve(false),
			remove: family => {
				removed.push(family)
			}
		}
		let latest: DocxDocument | undefined

		act(() =>
			root.render(
				<Probe
					source={{ host: manual.host, bytes: bytesSource(new Uint8Array(1)), fontHost }}
					onDocument={document => (latest = document)}
				/>
			)
		)
		manual.emit({
			type: "fonts",
			faces: [{ kind: "bytes", face: { family: "fo1a2b-carlito", weight: 400, italic: false }, bytes: new Uint8Array(4) }]
		})
		manual.emit(pagesEvent([page(0, ["text"])], true))
		await flush()
		expect(added).toHaveLength(1)
		expect(latest?.pages).toHaveLength(0)

		release()
		await flush()
		expect(latest?.pages).toHaveLength(1)

		act(() => root.render(<div />))
		await flush()
		expect(removed).toEqual(["fo1a2b-carlito"])
		expect(manual.closed()).toBe(true)
	})
})

describe("DocxDocumentStore", () => {
	it("applies events at once while nothing waits and every face is loaded, else in order once the faces are", async () => {
		const manual = manualHost()
		let release: () => void = () => undefined
		const fontHost: FontHost = {
			addBytes: () =>
				new Promise(resolve => {
					release = () => resolve(true)
				}),
			addLocal: () => Promise.resolve(false),
			remove: () => undefined
		}
		const store = new DocxDocumentStore({ host: manual.host, bytes: bytesSource(new Uint8Array(1)), fontHost })
		const stop = store.subscribe(() => undefined)
		const shown = (): (number | undefined)[] => store.getSnapshot().pages.map(page => page.index)

		// In the task that sent it (an edit's pages reach the view in the edit's render).
		manual.emit(pagesEvent([page(0, ["a"])], false))
		expect(shown()).toEqual([0])

		// A face on its way: pages wait for it, and later events wait behind them.
		manual.emit({
			type: "fonts",
			faces: [{ kind: "bytes", face: { family: "fo1a2b-carlito", weight: 400, italic: false }, bytes: new Uint8Array(4) }]
		})
		manual.emit(pagesEvent([page(1, ["b"])], false))
		manual.emit(pagesEvent([page(2, ["c"])], false))
		expect(shown()).toEqual([0])

		release()
		await flush()
		expect(shown()).toEqual([0, 1, 2])

		// Everything in again: at once.
		manual.emit(pagesEvent([page(3, ["d"])], true))
		expect(shown()).toEqual([0, 1, 2, 3])
		stop()
	})
})

describe("find and viewer commands", () => {
	it("finds across pages once per match, case-insensitively by default", () => {
		const pages = [page(0, ["Alpha beta ALPHA", "gamma"]), page(1, ["alphabet (a.*)"])]

		expect(findInDocument(pages, "alpha").map(match => [match.page, match.source, match.start])).toEqual([
			[0, 0, 0],
			[0, 0, 11],
			[1, 0, 0]
		])
		expect(findInDocument(pages, "alpha", { caseSensitive: true })).toHaveLength(1)
		expect(findInDocument(pages, "(a.*)")).toHaveLength(1)
		expect(findInDocument(pages, "")).toEqual([])
	})

	it("validates bridge commands and computes enablement and zoom steps", () => {
		expect(parseDocxViewerCommand({ type: "zoom.set", zoom: 99 })).toEqual({ type: "zoom.set", zoom: 4 })
		expect(parseDocxViewerCommand({ type: "page.goto", page: -1 })).toBeUndefined()
		expect(parseDocxViewerCommand({ type: "eval" })).toBeUndefined()
		expect(parseDocxViewerCommand("zoom.in")).toBeUndefined()

		const state: DocxViewerState = {
			status: "ready",
			capabilities: DOCX_VIEWER_CAPABILITIES,
			page: 0,
			pageCount: 3,
			pageCountFinal: true,
			zoom: 1,
			zoomMode: "custom",
			find: { open: false, query: "", caseSensitive: false, count: 0, capped: false, active: -1 }
		}

		expect(state.capabilities.readOnly).toBe(true)
		expect(isDocxCommandEnabled(state, "page.previous")).toBe(false)
		expect(isDocxCommandEnabled(state, "page.next")).toBe(true)
		expect(isDocxCommandEnabled(state, "find.next")).toBe(false)
		expect(stepZoom(1, 1)).toBe(1.1)
		expect(stepZoom(1, -1)).toBe(0.9)
		expect(fitWidthZoom(500, 816, 16)).toBeCloseTo((500 - 32) / 816)
		expect(fitWidthZoom(5000, 816, 16)).toBe(1)
	})
})
