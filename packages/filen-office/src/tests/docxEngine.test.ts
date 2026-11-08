import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bytesSource, type ByteSource } from "@filen/office/core/opc"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import {
	DocxEngine,
	FIND_INTS,
	docxWorkerPool,
	findMatches,
	inThreadDocxHost,
	parseHyperlinkField,
	serveDocxWorker,
	type DocxEngineServices,
	type DocxEvent,
	type DocxPageData,
	type DocxWorkerLike,
	type DocxWorkerScope
} from "@filen/office/dom/docx"
import { fontFaceHost } from "@filen/office/dom"
import { buildDocx } from "./docxSynthetic"
import { png } from "./security/generate"

// A picture whose header the viewer reads (one it cannot read is not served).
const IMAGE = png(4, 3)

// A measurer without a browser: every character half an em wide.
const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => Promise.resolve(),
		sliceMs: Infinity
	}
}

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
}

const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture"

const LINKED = buildDocx({
	body:
		'<w:p><w:hyperlink r:id="rIdLink" w:tooltip="Site"><w:r><w:t>Visit us</w:t></w:r></w:hyperlink><w:r><w:t> and </w:t></w:r>' +
		'<w:hyperlink w:anchor="target"><w:r><w:t>jump</w:t></w:r></w:hyperlink></w:p>' +
		'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:a@b.c" </w:instrText></w:r>' +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Mail</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
		'<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
		'<w:p><w:bookmarkStart w:id="0" w:name="target"/><w:r><w:t>Here</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>' +
		'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="d"/><a:graphic><a:graphicData uri="' +
		PICTURE +
		'"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
	relationships: [
		{ id: "rIdLink", type: "hyperlink", target: "https://example.com/a", external: true },
		{ id: "rIdImg", type: "image", target: "media/image1.png" }
	],
	parts: [{ name: "word/media/image1.png", data: IMAGE }]
})

interface Run {
	readonly events: DocxEvent[]
	readonly pages: DocxPageData[]
	readonly engine: DocxEngine
}

async function run(bytes: Uint8Array): Promise<Run> {
	const events: DocxEvent[] = []
	const pages: DocxPageData[] = []
	const engine = new DocxEngine(bytesSource(bytes), services(), event => {
		events.push(event)

		if (event.type === "pages") for (const page of event.pages) pages[page.index] = page
	})

	await engine.run()

	return { events, pages, engine }
}

describe("DocxEngine", () => {
	it("opens, then streams pages with their style tables and ends final", async () => {
		const { events, pages } = await run(fixture("03-header-footer-footnotes.docx"))

		expect(events[0]?.type).toBe("opened")

		const batches = events.filter(event => event.type === "pages")
		const last = batches[batches.length - 1]

		// Exactly one final batch.
		expect(batches.filter(event => event.type === "pages" && event.final)).toHaveLength(1)

		expect(last?.type === "pages" && last.final).toBe(true)
		expect(last?.type === "pages" ? last.pageCount : 0).toBe(pages.length)
		expect(pages.length).toBeGreaterThan(0)

		const styles = batches.flatMap(event => (event.type === "pages" ? event.styles : []))
		const usedStyles = pages.flatMap(page => Array.from({ length: page.fragmentCount }, (_, k) => page.fragmentInts[k * 5 + 2] ?? -1))

		expect(Math.max(...usedStyles)).toBeLessThan(styles.length)

		for (const style of styles) {
			expect(style.font).toMatch(/px /)
			expect(style.ascent).toBeGreaterThan(0)
			expect(style.color === "" || /^[0-9A-Fa-f]{6}$/.test(style.color)).toBe(true)
		}
	})

	it("finds hyperlinks, field links and bookmarks, and serves objects and media", async () => {
		const { events, pages, engine } = await run(LINKED)
		const links = events.flatMap(event => (event.type === "pages" ? event.links : []))

		expect(links).toEqual([
			{ kind: "external", href: "https://example.com/a", tooltip: "Site" },
			{ kind: "internal", anchor: "target", tooltip: undefined },
			{ kind: "external", href: "mailto:a@b.c", tooltip: undefined }
		])

		const first = pages[0]

		expect(first).toBeDefined()

		if (first === undefined) return

		const ranges = Array.from({ length: first.linkCount }, (_, k) => {
			const at = k * 4

			return (first.sourceTexts[first.linkInts[at] ?? 0] ?? "").slice(first.linkInts[at + 1], first.linkInts[at + 2])
		})

		expect(ranges).toEqual(["Visit us", "jump", "Mail"])

		const location = await engine.locate("target")

		expect(location?.page).toBe(1)
		expect(await engine.locate("missing")).toBeNull()

		const page = pages[1]
		const objectId = page?.objectInts[0] ?? -1

		expect(page?.objectCount).toBe(1)

		const [object] = await engine.objects([objectId])

		expect(object?.kind).toBe("drawing")

		if (object?.kind !== "drawing") return

		const image = object.drawing.images[0]

		expect(image?.partName).toBe("word/media/image1.png")

		const media = await engine.media("word/media/image1.png")

		expect(Array.from(media?.bytes ?? [])).toEqual(Array.from(IMAGE))
		expect(await engine.media("word/missing.png")).toBeNull()
	})

	it("keeps answering objects, bookmarks, images and find after it drops the model", async () => {
		const { engine, pages } = await run(LINKED)
		const page = pages[1]
		const [object] = await engine.objects([page?.objectInts[0] ?? -1])

		// The model is gone (a viewer does not keep it): what was prepared stays.
		expect(Reflect.get(engine, "model")).toBeUndefined()
		expect(object?.kind).toBe("drawing")
		expect((await engine.locate("target"))?.page).toBe(1)
		expect((await engine.media("word/media/image1.png"))?.bytes.length).toBe(IMAGE.length)
		expect(Array.from(await engine.find("jump"))).toEqual([0, 0, 13, 17])
	})

	it("keeps the model when asked to", async () => {
		const engine = new DocxEngine(bytesSource(LINKED), services(), () => undefined, { retain: true })

		await engine.run()
		expect(Reflect.get(engine, "model")).toBeDefined()
		engine.close()
	})

	it("reports the first section's page size and the main part's size", async () => {
		const { events } = await run(fixture("03-header-footer-footnotes.docx"))
		const opened = events[0]

		expect(opened?.type).toBe("opened")

		if (opened?.type !== "opened") return

		expect(opened.info.pageWidth).toBeGreaterThan(700)
		expect(opened.info.pageHeight).toBeGreaterThan(opened.info.pageWidth)
		expect(opened.info.mainPartBytes).toBeGreaterThan(0)
	})

	it("reports why a file cannot be opened", async () => {
		const notZip = await run(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))

		expect(notZip.events).toEqual([{ type: "error", reason: "notZip", message: expect.any(String) }])
	})

	it("stops when closed and answers nothing afterwards", async () => {
		const events: DocxEvent[] = []
		const engine = new DocxEngine(bytesSource(fixture("08-large-300p.docx")), { ...services(), sliceMs: 1 }, event => {
			events.push(event)

			if (event.type === "pages" && event.pages.length > 0) engine.close()
		})

		await engine.run()

		expect(engine.closed).toBe(true)
		expect(events.filter(event => event.type === "pages")).toHaveLength(1)
		expect(await engine.objects([0])).toEqual([])
		expect(await engine.media("word/document.xml")).toBeNull()
	})
})

// An in-memory pair of ports between a fake page and a fake worker, cloning like postMessage does.
function channel(): { worker: DocxWorkerLike; scope: DocxWorkerScope; transferred: ArrayBuffer[]; terminated: () => boolean } {
	let toWorker: ((data: unknown) => void) | undefined
	let toPage: ((data: unknown) => void) | undefined
	let terminated = false
	const transferred: ArrayBuffer[] = []
	const deliver = (target: ((data: unknown) => void) | undefined, message: unknown, transfer: readonly ArrayBuffer[]): void => {
		const copy = structuredClone(message, { transfer: [...transfer] })

		transferred.push(...transfer)
		queueMicrotask(() => target?.(copy))
	}

	return {
		worker: {
			post: (message, transfer) => deliver(toWorker, message, transfer),
			listen: onMessage => {
				toPage = onMessage
			},
			terminate: () => {
				terminated = true
			}
		},
		scope: {
			post: (message, transfer) => deliver(toPage, message, transfer),
			listen: onMessage => {
				toWorker = onMessage
			}
		},
		transferred,
		terminated: () => terminated
	}
}

describe("worker host", () => {
	it("runs a document over the message protocol, reading ranges without moving the caller's bytes", async () => {
		const bytes = fixture("05-fields-toc.docx")
		const before = bytes.slice()
		const reads: [number, number][] = []
		const source: ByteSource = {
			size: bytes.length,
			read: (offset, length) => {
				reads.push([offset, length])

				return bytesSource(bytes).read(offset, length)
			}
		}
		const pair = channel()

		serveDocxWorker(pair.scope, () => services())

		const pool = docxWorkerPool(() => pair.worker, 10)
		const host = pool.host
		const events: DocxEvent[] = []
		const done = Promise.withResolvers<void>()
		const session = host(source, event => {
			events.push(event)

			if ((event.type === "pages" && event.final) || event.type === "error") done.resolve()
		})

		await done.promise

		const pages = events.flatMap(event => (event.type === "pages" ? event.pages : []))

		expect(pages.length).toBeGreaterThan(1)
		expect(reads.length).toBeGreaterThan(0)
		// The caller's buffer is never transferred or changed: only copies of the ranges travel.
		expect(bytes.byteLength).toBe(before.byteLength)
		expect(bytes).toEqual(before)
		expect(pair.transferred).not.toContain(bytes.buffer)

		const links = events.flatMap(event => (event.type === "pages" ? event.links : []))
		const internal = links.find(link => link.kind === "internal")

		expect(internal).toBeDefined()

		if (internal?.kind === "internal") expect(await session.locate(internal.anchor)).not.toBeNull()

		const found = await session.find("section")

		expect(found.length).toBeGreaterThan(0)
		expect(found.length % 4).toBe(0)

		// A second document on the same worker while the first is open, then both closed.
		const second = Promise.withResolvers<number>()
		const other = host(bytesSource(fixture("01-plain.docx")), event => {
			if (event.type === "pages" && event.final) second.resolve(event.pageCount)
		})

		expect(await second.promise).toBe(1)
		session.close()
		other.close()
		await expect(session.media("word/document.xml")).rejects.toThrow("closed")

		// The worker outlives its documents for a while, then goes.
		expect(pair.terminated()).toBe(false)
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(pair.terminated()).toBe(true)
	})

	it("fails every open document when the worker dies", async () => {
		const pair = channel()
		let crash: () => void = () => undefined
		const pool = docxWorkerPool(() => ({
			...pair.worker,
			listen: (onMessage, onError) => {
				pair.worker.listen(onMessage, onError)
				crash = onError
			}
		}))
		const events: DocxEvent[] = []

		pool.host(bytesSource(fixture("01-plain.docx")), event => events.push(event))
		crash()

		expect(events).toEqual([{ type: "error", reason: "failed", message: "The document worker failed" }])
		expect(pair.terminated()).toBe(true)
	})

	it("an in-thread engine keeps the page's fonts until the document closes", async () => {
		const removed: string[] = []
		const fontHost = {
			addBytes: () => Promise.resolve(true),
			addLocal: () => Promise.resolve(false),
			remove: (family: string) => {
				removed.push(family)
			}
		}
		const host = inThreadDocxHost(() => ({ ...services(), fontHost, replayFonts: false }))
		const done = Promise.withResolvers<void>()
		const session = host(bytesSource(fixture("05-fields-toc.docx")), event => {
			if (event.type === "pages" && event.final) done.resolve()
		})

		await done.promise
		// Past the release that follows the last page.
		expect((await session.find("section")).length).toBeGreaterThan(0)
		expect(removed).toEqual([])

		session.close()
		expect(removed.length).toBeGreaterThan(0)
	})

	it("in-thread host gives the same pages", async () => {
		const bytes = fixture("05-fields-toc.docx")
		const host = inThreadDocxHost(() => services())
		const done = Promise.withResolvers<number>()
		const session = host(bytesSource(bytes), event => {
			if (event.type === "pages" && event.final) done.resolve(event.pageCount)
		})
		const direct = await run(bytes)

		expect(await done.promise).toBe(direct.pages.length)
		session.close()
	})
})

describe("findMatches", () => {
	const page = (text: string) => ({
		index: 0,
		sourceCount: 1,
		sourceTexts: [text],
		lineCount: 1,
		lineInts: Int32Array.from([0, 1, 0, text.length, 1, 0, 0])
	})

	it("matches across Unicode normalisation forms, case-insensitively, on whole characters", () => {
		const nfd = "Le CAFE\u0301 et le cafe\u0301"

		expect(Array.from(findMatches([page(nfd)], "café"))).toEqual([0, 0, 3, 8, 0, 0, 15, 20])
		expect(Array.from(findMatches([page("café")], "cafe\u0301"))).toEqual([0, 0, 0, 4])
		// A match ending on a base letter takes its combining mark along.
		expect(Array.from(findMatches([page(nfd)], "cafe", { caseSensitive: true }))).toEqual([])
		expect(Array.from(findMatches([page("e\u0301x")], "é"))).toEqual([0, 0, 0, 2])
	})

	it("finds whole words only when asked, as the editing find does", () => {
		const text = "the other them, The. théâtre the_x"

		expect(findMatches([page(text)], "the").length / FIND_INTS).toBe(5)
		expect(Array.from(findMatches([page(text)], "the", { wholeWord: true }))).toEqual([0, 0, 0, 3, 0, 0, 16, 19])
	})

	it("stops one match past the limit, which tells that there are more", () => {
		expect(findMatches([page("a a a a a")], "a", { limit: 3 }).length / FIND_INTS).toBe(4)
		expect(findMatches([page("a a a")], "a", { limit: 3 }).length / FIND_INTS).toBe(3)
	})
})

describe("parseHyperlinkField", () => {
	it("reads targets, anchors and tooltips", () => {
		expect(parseHyperlinkField(' HYPERLINK "https://x.test/a b" ')).toEqual({
			kind: "external",
			href: "https://x.test/a b",
			tooltip: undefined
		})
		expect(parseHyperlinkField('HYPERLINK \\l "_Toc1" \\h')).toEqual({ kind: "internal", anchor: "_Toc1", tooltip: undefined })
		expect(parseHyperlinkField('HYPERLINK "https://x.test" \\o "Tip"')).toEqual({
			kind: "external",
			href: "https://x.test",
			tooltip: "Tip"
		})
		expect(parseHyperlinkField("HYPERLINK https://x.test")).toEqual({ kind: "external", href: "https://x.test", tooltip: undefined })
		expect(parseHyperlinkField("PAGE")).toBeUndefined()
		expect(parseHyperlinkField("HYPERLINK")).toBeUndefined()
	})
})

describe("fontFaceHost", () => {
	it("does not add a face whose family was removed while it loaded", async () => {
		let finish: () => void = () => undefined
		const added: unknown[] = []
		const host = fontFaceHost({
			FontFace: class {
				load(): Promise<unknown> {
					return new Promise(resolve => {
						finish = () => resolve(undefined)
					})
				}
			},
			fonts: { add: face => added.push(face), delete: () => true }
		})
		const loading = host.addBytes({ family: "fo1-a", weight: 400, italic: false }, new Uint8Array(4))

		host.remove("fo1-a")
		finish()

		expect(await loading).toBe(false)
		expect(added).toEqual([])
	})
})
