import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strToU8, zipSync } from "fflate"
import { afterAll, describe, expect, it } from "vitest"
import { cfbBytes } from "../../../core/cfb/index"
import {
	indexDeck,
	isEncryptedPpt,
	mostAnimated,
	ooxmlSample,
	readCorpusList,
	smartArtSlides,
	verticalTextSlides,
	type DeckIndex
} from "./corpus"
import { loCacheDir, loRendered, loSlideImages, readLoCache, readLoIndex, withLoFeatures } from "./lo"
import { encodePng } from "./pixel"

// The presentation corpus index the acceptances sample from, and the LibreOffice cache as tests read it.

const dir = mkdtempSync(join(tmpdir(), "presentation-corpus-"))

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

function rels(items: readonly (readonly [string, string, string])[]): string {
	return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
		.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
		.join("")}</Relationships>`
}

// Slides listed out of part order: the index follows sldIdLst. Slide 2 (part slide1.xml) has vertical text and
// SmartArt with its drawing; slide 1 (part slide2.xml) has three time nodes and SmartArt without one.
function deck(): Uint8Array {
	return zipSync({
		"ppt/presentation.xml": strToU8(
			'<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>'
		),
		"ppt/_rels/presentation.xml.rels": strToU8(
			rels([
				["rId2", "slide", "slides/slide1.xml"],
				["rId3", "slide", "slides/slide2.xml"]
			])
		),
		"ppt/slides/slide1.xml": strToU8('<p:sld><a:bodyPr vert="eaVert"/><a:bodyPr vert="vert270"/><dgm:relIds r:dm="rId5"/></p:sld>'),
		"ppt/slides/_rels/slide1.xml.rels": strToU8(rels([["rId9", "diagramDrawing", "../diagrams/drawing1.xml"]])),
		"ppt/slides/slide2.xml": strToU8(
			'<p:sld><a:bodyPr vert="horz"/><p:cTn id="1"/><p:cTn id="2"/><p:cTn id="3"/><dgm:relIds r:dm="rId5"/></p:sld>'
		),
		"ppt/slides/_rels/slide2.xml.rels": strToU8(rels([]))
	})
}

function odp(): Uint8Array {
	return zipSync({
		"content.xml": strToU8(
			'<office:document-content><style:style style:name="P1"><style:paragraph-properties style:writing-mode="tb-rl"/></style:style><style:style style:name="P2"/>' +
				'<draw:page draw:name="a"><draw:frame draw:text-style-name="P2"/><anim:par><anim:seq><anim:set/></anim:seq></anim:par>' +
				'<presentation:notes><draw:page-thumbnail draw:page-number="1"/></presentation:notes></draw:page>' +
				'<draw:page draw:name="b"><draw:frame draw:style-name="P1"/></draw:page></office:document-content>'
		)
	})
}

describe("the presentation corpus index", () => {
	it("reads a manifest, a frozen list of paths and a frozen list of entries", () => {
		const write = (name: string, value: unknown): string => {
			const file = join(dir, name)

			writeFileSync(file, JSON.stringify(value))

			return file
		}

		expect(readCorpusList(write("m.json", { files: [{ path: "pptx/a.pptx", sha256: "ab", size: 3 }] }))).toEqual([
			{ path: "pptx/a.pptx", sha256: "ab", size: 3 }
		])
		expect(readCorpusList(write("l.json", ["odp/b.odp"]))).toEqual([{ path: "odp/b.odp", sha256: "" }])
		expect(() => readCorpusList(write("x.json", { other: 1 }))).toThrow(/neither/)
	})

	it("indexes OOXML slides in presentation order with their vertical text, time nodes and SmartArt", async () => {
		mkdirSync(join(dir, "pptx"), { recursive: true })
		mkdirSync(join(dir, "odp"), { recursive: true })
		writeFileSync(join(dir, "pptx", "a.pptx"), deck())
		writeFileSync(join(dir, "odp", "b.odp"), odp())

		const index: DeckIndex[] = [
			await indexDeck(dir, { path: "pptx/a.pptx", sha256: "a" }),
			await indexDeck(dir, { path: "odp/b.odp", sha256: "b" })
		]

		expect(index[0]?.slides).toEqual([
			{ slide: 1, vertical: [], animationNodes: 3, smartArt: { cached: 0, uncached: 1 } },
			{ slide: 2, vertical: ["eaVert", "vert270"], animationNodes: 0, smartArt: { cached: 1, uncached: 0 } }
		])
		expect(index[1]?.slides.map(slide => [slide.vertical, slide.animationNodes])).toEqual([
			[[], 3],
			[["writing-mode"], 0]
		])
		expect(verticalTextSlides(index).map(ref => `${ref.path}#${String(ref.slide)}`)).toEqual(["pptx/a.pptx#2", "odp/b.odp#2"])
		expect(mostAnimated(index, 1)).toEqual([{ path: "odp/b.odp", sha256: "b", slide: 1, nodes: 3 }])
		expect(smartArtSlides(index).map(ref => [ref.slide, ref.cached, ref.uncached])).toEqual([
			[1, 0, 1],
			[2, 1, 0]
		])
		expect(ooxmlSample(index, 2)).toEqual([{ path: "pptx/a.pptx", sha256: "a", slide: 1 }])
	})

	it("tells an encrypted .ppt by its CurrentUserAtom header token", async () => {
		const currentUser = (token: number): Uint8Array => {
			const bytes = new Uint8Array(32)

			new DataView(bytes.buffer).setUint32(12, token, true)

			return bytes
		}
		const ppt = async (token: number): Promise<Uint8Array> =>
			cfbBytes([
				{ path: ["Current User"], bytes: currentUser(token) },
				{ path: ["PowerPoint Document"], bytes: new Uint8Array(64) }
			])

		expect(await isEncryptedPpt(await ppt(0xf3d1c4df))).toBe(true)
		expect(await isEncryptedPpt(await ppt(0xe391c05f))).toBe(false)
		expect(await isEncryptedPpt(deck())).toBeUndefined()
	})
})

describe("the LibreOffice cache", () => {
	it("serves a slide and its background, and no background where that pass failed", () => {
		const cache = join(dir, "cache")
		const sha = "0".repeat(64)
		const image = encodePng({ width: 2, height: 1, data: Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 255) })

		mkdirSync(join(cache, sha), { recursive: true })
		writeFileSync(
			join(cache, sha, "lo.json"),
			JSON.stringify({ file: "a.pptx", sha256: sha, slides: [{ bg: "ok" }, { bg: "RuntimeException: no" }] })
		)

		for (const name of ["slide-001.png", "slide-001-bg.png", "slide-002.png", "slide-002-bg.png"])
			writeFileSync(join(cache, sha, name), image)

		const entry = readLoCache(cache, sha)

		if (entry === undefined) throw new Error("not cached")

		expect(loSlideImages(entry, 1).bg?.width).toBe(2)
		expect(loSlideImages(entry, 2).bg).toBeUndefined()
		expect(loSlideImages(entry, 2).slide.data[4]).toBe(4)
		expect(readLoCache(cache, "1".repeat(64))).toBeUndefined()
		expect(readLoIndex(cache)).toEqual([])
	})

	it("indexes a binary deck's slides from LibreOffice's animation trees, the root not counted", () => {
		const cache = join(dir, "cache-binary")
		const sha = "2".repeat(64)
		const node = (children: unknown[] = []) => ({ type: 1, begin: null, dur: null, fill: null, children })

		mkdirSync(join(cache, sha), { recursive: true })
		writeFileSync(
			join(cache, sha, "lo.json"),
			JSON.stringify({ file: "a.ppt", sha256: sha, slides: [{ animation: node([node([node(), node()])]) }, {}] })
		)

		const binary = { path: "ppt/a.ppt", sha256: sha, format: "ppt", slides: [], skipped: "binary (indexed from LibreOffice's JSON)" }

		expect(withLoFeatures(binary, cache).slides.map(slide => slide.animationNodes)).toEqual([3, 0])
		expect(withLoFeatures({ ...binary, skipped: "encrypted ppt" }, cache).slides).toEqual([])
	})

	const cache = loCacheDir()

	it.skipIf(cache === undefined)("has every slide and background image for each deck its index lists as cached", () => {
		const index = readLoIndex(cache ?? "")
		const missing: string[] = []

		expect(index.length).toBeGreaterThan(0)

		for (const item of index) {
			if (item.status !== "cached") {
				expect(item.reason, item.path).toBeTruthy()

				continue
			}

			const entry = readLoCache(cache ?? "", item.sha256)

			if (entry === undefined) {
				missing.push(`${item.path}: no lo.json`)

				continue
			}

			for (let slide = 1; slide <= item.slides; slide++) {
				const name = `slide-${String(slide).padStart(3, "0")}`

				if (!loRendered(entry, slide)) continue

				if (!existsSync(join(entry.dir, `${name}.png`))) missing.push(`${item.path}: ${name}.png`)
				if (entry.deck.slides?.[slide - 1]?.bg === "ok" && !existsSync(join(entry.dir, `${name}-bg.png`)))
					missing.push(`${item.path}: ${name}-bg.png`)
			}

			if (entry.deck.pdfError === undefined && !existsSync(join(entry.dir, "slides.pdf"))) missing.push(`${item.path}: slides.pdf`)
		}

		expect(missing).toEqual([])
	})
})
