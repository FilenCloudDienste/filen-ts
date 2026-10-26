import { describe, expect, it } from "vitest"
import { strToU8, unzipSync, zipSync } from "fflate"
import { bytesSource, type ByteSource } from "../core/opc/index"
import { imageDimensions, imageWithinBudget } from "../core/opc/mediaPolicy"
import { openPptx } from "../core/pptx/package"
import { DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../core/presentation/budget"
import { PresentationError } from "../core/presentation/model"
import { RenderReport } from "../core/presentation/render/effects"
import { renderSlide } from "../core/presentation/render/slide"
import type { Slicing } from "../core/slicing"
import { openRenderDeck } from "./fixtures/presentation/renderDeck"
import { buildPptx, body, para, sp, xfrm } from "./pptxFixtures"

const MIB = 1024 * 1024
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

function budgets(overrides: Partial<PresentationBudgets>): PresentationBudgets {
	return { ...DEFAULT_PRESENTATION_BUDGETS, ...overrides }
}

// A source that counts the bytes read from it before its last 70,000 bytes: the end-of-central-directory search
// reads up to 64 KiB of the tail, everything else read from further in is entry data.
function recorded(bytes: Uint8Array): ByteSource & { readonly head: () => number } {
	const inner = bytesSource(bytes)
	const tail = bytes.length - 70_000
	let head = 0

	return {
		size: inner.size,
		read(offset, length) {
			if (offset < tail) head += Math.min(length, tail - offset)

			return inner.read(offset, length)
		},
		head: () => head
	}
}

// A fixture zip with one entry's content replaced, and `filler` incompressible bytes in an entry after it.
function replaceEntry(zip: Uint8Array, name: string, data: Uint8Array<ArrayBuffer>, filler = 0): Uint8Array {
	const files = unzipSync(zip)

	files[name] = data

	if (filler > 0) {
		const noise = new Uint8Array(filler)
		let state = 0x2545f491

		for (let k = 0; k < filler; k++) {
			state ^= state << 13
			state ^= state >>> 17
			state ^= state << 5
			noise[k] = state & 0xff
		}

		files["ppt/media/filler.bin"] = noise
	}

	return zipSync(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, [bytes, { level: 9 }]])))
}

// Whitespace before the root's end tag: well-formed and highly compressible.
function padded(xml: string, pad: number): Uint8Array<ArrayBuffer> {
	const close = xml.lastIndexOf("</")
	const head = strToU8(xml.slice(0, close))
	const tail = strToU8(xml.slice(close))
	const out = new Uint8Array(head.length + pad + tail.length)

	out.set(head, 0)
	out.fill(0x20, head.length, head.length + pad)
	out.set(tail, head.length + pad)

	return out
}

const TITLE = sp(2, "T", 'type="title"', "", body(para("x")))

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
	} catch (error) {
		if (error instanceof PresentationError) return `${error.reason}: ${error.message}`

		throw error
	}

	return "rendered"
}

describe("package structure budgets", () => {
	it("refuses an oversized [Content_Types].xml from its declared size, without inflating it", { timeout: 60_000 }, async () => {
		const base = buildPptx({ slides: [{ shapes: TITLE }] })
		const types = new TextDecoder().decode(unzipSync(base)["[Content_Types].xml"])
		const zip = replaceEntry(base, "[Content_Types].xml", padded(types, 80 * MIB), 128 * 1024)
		const source = recorded(zip)
		const result = await openPptx(source)

		expect(result.kind).toBe("refused")
		expect(result.kind === "refused" ? result.reason : "").toBe("tooLarge")
		// The part's deflated bytes lie before the tail: reading them would mean it was inflated before the refusal.
		expect(zip.length).toBeGreaterThan(140_000)
		expect(source.head()).toBeLessThan(1024)
	})

	it("refuses relationships parts that together exceed the non-media total before reading any", { timeout: 120_000 }, async () => {
		// An audio part makes every relationships part needed for the media classes.
		const parts: Record<string, { data: string | Uint8Array; type?: string }> = {
			"ppt/media/media1.mp3": { data: new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0]), type: "audio/mpeg" }
		}
		const rels =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

		// 10 × 60 MiB: each within the 64 MiB part budget, together over the 512 MiB total.
		for (let k = 0; k < 10; k++) parts[`ppt/junk/_rels/j${k}.xml.rels`] = { data: padded(rels, 60 * MIB) }

		const zip = buildPptx({ slides: [{ shapes: TITLE }], parts })
		const source = recorded(zip)
		const result = await openPptx(source)

		expect(result.kind === "refused" ? result.reason : result.kind).toBe("tooLarge")
		expect(source.head()).toBeLessThan(1024)
	})

	it("refuses a relationships part over the XML part budget before reading it", async () => {
		const zip = buildPptx({ slides: [{ shapes: TITLE }] })
		const result = await openPptx(bytesSource(zip), { budgets: budgets({ xmlPartBytes: 64 }) })

		expect(result.kind === "refused" ? result.reason : result.kind).toBe("tooLarge")
		expect(result.kind === "refused" ? result.detail : "").toMatch(/rels|Content_Types/u)
	})

	it("checks every other entry against its class before the relationships parts are read", async () => {
		// An audio candidate, and a 70 MiB non-media part: refused before the relationships are read.
		const zip = buildPptx({
			slides: [{ shapes: TITLE }],
			parts: {
				"ppt/media/media1.mp3": { data: new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0]), type: "audio/mpeg" },
				"ppt/embeddings/big.bin": { data: new Uint8Array(70 * MIB), type: "application/octet-stream" }
			}
		})
		const source = recorded(zip)
		const result = await openPptx(source)

		expect(result.kind === "refused" ? result.reason : result.kind).toBe("tooLarge")
		expect(source.head()).toBeLessThan(1024)
	})
})

describe("per-deck tally", () => {
	it("counts a released and re-parsed slide's characters once", async () => {
		const zip = buildPptx({ slides: [{ shapes: sp(2, "T", 'type="title"', "", body(para("x".repeat(1000)))) }] })
		const opened = await openPptx(bytesSource(zip), { budgets: budgets({ charactersPerDeck: 5000 }) })

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const ref = opened.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		for (let k = 0; k < 10; k++) {
			await opened.parts.slide(ref)
			opened.parts.release(ref)
		}

		await expect(opened.parts.slide(ref)).resolves.toBeDefined()
		expect(opened.parts.tally.characters).toBeLessThan(2000)
	})
})

describe("per-slide reader budgets", () => {
	it("refuses a slide whose text runs exceed the per-slide budget, each body within its own", async () => {
		const runs = (n: number): string => para(Array.from({ length: n }, () => "x").join("</a:t></a:r><a:r><a:t>"))
		const shapes = [3, 4, 5].map(id => sp(id, `B${String(id)}`, undefined, "", body(runs(40)))).join("")
		const zip = buildPptx({ slides: [{ shapes }] })
		const opened = await openPptx(bytesSource(zip), { budgets: budgets({ runsPerBody: 50, runsPerSlide: 100 }) })

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const ref = opened.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		expect(await refusal(opened.parts.slide(ref))).toMatch(/^tooLarge: .*text runs on a slide/u)
	})

	it("refuses a slide whose table cells exceed the per-slide budget, each table within its own", async () => {
		const table = (id: number): string =>
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${String(id)}" name="T${String(id)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
			'<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
			`<a:tbl><a:tblGrid><a:gridCol w="10"/></a:tblGrid>${'<a:tr h="10"><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr>'.repeat(30)}</a:tbl>` +
			"</a:graphicData></a:graphic></p:graphicFrame>"
		const zip = buildPptx({ slides: [{ shapes: table(3) + table(4) }] })
		const opened = await openPptx(bytesSource(zip), { budgets: budgets({ cellsPerTable: 40, cellsPerSlide: 50 }) })

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const ref = opened.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		expect(await refusal(opened.parts.slide(ref))).toMatch(/^tooLarge: .*table cells on a slide/u)
	})
})

// A p:sp with a custom geometry of `commands` path commands.
function custom(id: number, commands: number): string {
	const path = `<a:moveTo><a:pt x="0" y="0"/></a:moveTo>${'<a:lnTo><a:pt x="10" y="10"/></a:lnTo>'.repeat(commands - 1)}`

	return sp(
		id,
		`C${String(id)}`,
		undefined,
		`${xfrm(0, 0, 100, 100)}<a:custGeom><a:pathLst><a:path w="10" h="10">${path}</a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`
	)
}

async function renderWith(shapes: string, overrides: Partial<PresentationBudgets>, report = new RenderReport()) {
	const opened = await openRenderDeck(buildPptx({ slides: [{ shapes }], layouts: [{ name: "Blank", type: "blank", shapes: "" }] }))

	if (opened === undefined) throw new Error("not opened")

	const ref = opened.deck.slides[0]

	if (ref === undefined) throw new Error("no slide")

	return renderSlide(opened.deck, ref, { ...opened.services, budgets: budgets(overrides) }, SLICING, report)
}

describe("per-shape and per-slide render budgets", () => {
	it("refuses a custom geometry with more path commands than one shape may, and draws the others", async () => {
		const report = new RenderReport()
		const render = await renderWith(custom(3, 50) + custom(4, 5), { pathCommandsPerShape: 20 }, report)

		expect(report.unsupported.get("custGeom:tooLarge")).toBe(1)

		const over = render.layers.find(layer => layer.shape.id === 3)
		const within = render.layers.find(layer => layer.shape.id === 4)

		expect(over?.drawing.itemCount).toBe(0)
		expect(within?.drawing.itemCount).toBeGreaterThan(0)
	})

	it("refuses a slide whose custom geometries together exceed the per-slide path commands, before drawing them", async () => {
		const shapes = [3, 4, 5].map(id => custom(id, 15)).join("")

		expect(await refusal(renderWith(shapes, { pathCommandsPerShape: 20, pathCommandsPerSlide: 40 }))).toMatch(
			/^tooLarge: path commands on a slide/u
		)
	})

	it("refuses a slide whose display items exceed the per-slide budget", async () => {
		const shapes = Array.from({ length: 30 }, (_, k) => custom(3 + k, 2)).join("")

		await expect(renderWith(shapes, {})).resolves.toBeDefined()
		expect(await refusal(renderWith(shapes, { displayItemsPerSlide: 10 }))).toMatch(/^tooLarge: display items on a slide/u)
	})
})

describe("decoded-pixel budget from image headers", () => {
	// FFD8, two 64 KiB APP segments, then a 30000 × 30000 SOF0 (900 M pixels).
	function deepJpeg(): Uint8Array {
		const app = (marker: number): Uint8Array => {
			const segment = new Uint8Array(2 + 65535)

			segment.set([0xff, marker, 0xff, 0xff])

			return segment
		}
		const parts = [
			new Uint8Array([0xff, 0xd8]),
			app(0xe1),
			app(0xe2),
			new Uint8Array([0xff, 0xc0, 0x00, 0x11, 0x08, 0x75, 0x30, 0x75, 0x30, 0x03])
		]
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
		let at = 0

		for (const part of parts) {
			out.set(part, at)
			at += part.length
		}

		return out
	}

	it("reads a JPEG's size when its APP segments push the frame header past the first 64 KiB", () => {
		const jpeg = deepJpeg()

		expect(imageDimensions(jpeg)).toEqual({ width: 30000, height: 30000 })
		expect(imageWithinBudget(jpeg)).toBe(false)
	})

	it("refuses a raster header that does not give its size within the bytes given", () => {
		expect(imageWithinBudget(deepJpeg().subarray(0, 64 * 1024))).toBe(false)
		expect(imageWithinBudget(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false)
		// A scan before any frame header.
		expect(imageWithinBudget(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0]))).toBe(false)
	})

	it("holds images to the deck's decoded-pixel budget", () => {
		const png = new Uint8Array(24)

		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
		new DataView(png.buffer).setUint32(16, 100)
		new DataView(png.buffer).setUint32(20, 100)

		expect(imageWithinBudget(png, budgets({}))).toBe(true)
		expect(imageWithinBudget(png, budgets({ decodedPixels: 9_999 }))).toBe(false)
	})
})
