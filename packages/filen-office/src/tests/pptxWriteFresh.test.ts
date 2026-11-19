import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { freshPptx, transitionalPart } from "../core/pptx/write/fresh"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import type { Deck, ShapeNode } from "../core/presentation/model"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { budget } from "./timing"
import { openDeck, partsOf, shapeOf, slideNode, text } from "./pptxWriteFixtures"

// The fresh writer: a whole package from the model (every node parsed), the source's media and unmodeled markup
// copied. With FILEN_OFFICE_PPTX_FRESH_OUT set, every corpus output is written there for the Open XML SDK and
// LibreOffice runs.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files.filter(file => /^(pptx|pptm|potx|potm|ppsx|ppsm)\//u.test(file.path) && file.password === undefined)
const PRESENT = FILES.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const OUT = process.env["FILEN_OFFICE_PPTX_FRESH_OUT"]

async function fresh(deck: Deck, source: Parameters<typeof freshPptx>[1]): Promise<Uint8Array> {
	const sink = memorySink()
	const outcome = await freshPptx(deck, source, sink, {})

	if (outcome.kind !== "written")
		throw new Error(`${outcome.kind} ${outcome.kind === "refused" ? `${outcome.reason} ${outcome.detail ?? ""}` : ""}`)

	return sink.bytes()
}

// What a shape is, for comparing a deck with its fresh rewrite.
function summary(shapes: readonly ShapeNode[]): unknown[] {
	return shapes.map(shape => ({
		kind: shape.kind,
		name: shape.name,
		ph: shape.ph?.type,
		xfrm: shape.xfrm === undefined ? undefined : [shape.xfrm.x, shape.xfrm.y, shape.xfrm.cx, shape.xfrm.cy, shape.xfrm.rot],
		text: shape.text?.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")).join("\n"),
		children: shape.children === undefined ? undefined : summary(shape.children)
	}))
}

describe("pptx fresh writer", () => {
	it("writes a deck whole from its model: slides, layouts, master, notes, sections; an edit shows", async () => {
		const bytes = buildPptx({
			slides: [
				{
					shapes:
						sp(2, "Title 1", 'type="title"', "", body(para("Hello", ' b="1"'))) +
						sp(
							5,
							"Box",
							undefined,
							`${xfrm(100, 200, 300, 400)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>`,
							body(para("Box text"))
						),
					notes: para("Speaker notes")
				},
				{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Second"))), attributes: ' show="0"' }
			]
		})
		const opened = await openDeck(bytes)

		shapeOf(slideNode(opened, 0), 5).props = { fill: { kind: "solid", color: { kind: "scheme", slot: "accent1" } } }

		const out = await fresh(opened.deck, opened.source)
		const back = await openDeck(out)
		const parts = await partsOf(out)

		expect(back.deck.slides).toHaveLength(2)
		expect(slideNode(back, 1).hidden).toBe(true)
		expect(summary(slideNode(back, 0).shapes)).toEqual(summary(slideNode(opened, 0).shapes))
		expect(back.deck.layouts.map(ref => back.deck.nodes.get(ref)?.name)).toEqual(["Title and Content", "Blank"])
		expect(text(parts.get("ppt/slides/slide1.xml"))).toContain(
			'<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'
		)
		expect(text(parts.get("ppt/notesSlides/notesSlide1.xml"))).toContain("Speaker notes")
		expect(text(parts.get("ppt/notesSlides/_rels/notesSlide1.xml.rels"))).toContain("../slides/slide1.xml")
	})

	it("is deterministic: the same deck gives the same bytes", async () => {
		const opened = await openDeck(buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Same"))) }] }))

		expect(await fresh(opened.deck, opened.source)).toEqual(await fresh(opened.deck, opened.source))
	})

	it("hands its slicing to the zip writer and returns the zip's report, the bytes unchanged", async () => {
		const opened = await openDeck(buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Sliced"))) }] }))
		let looks = 0
		const slicing = { sliceMs: 1_000_000, now: () => (looks++, 0), pause: () => Promise.resolve() }
		const plain = memorySink()
		const sliced = memorySink()
		const outcome = await freshPptx(opened.deck, opened.source, sliced, { slicing })

		await freshPptx(opened.deck, opened.source, plain, {})

		if (outcome.kind !== "written") throw new Error(outcome.kind)

		const bytes = sliced.bytes()

		expect(looks).toBeGreaterThan(0)
		expect(bytes).toEqual(plain.bytes())
		expect(outcome.report.size).toBe(bytes.length)
		expect(outcome.report.entries).toBe((await partsOf(bytes)).size)
		expect(outcome.report.crcs.size).toBe(outcome.report.entries)
	})

	describe("a Strict part copied as Transitional", () => {
		const STRICT_A = "http://purl.oclc.org/ooxml/drawingml/main"
		const STRICT_C = "http://purl.oclc.org/ooxml/drawingml/chart"
		const STRICT_P = "http://purl.oclc.org/ooxml/presentationml/main"
		const transitional = (xml: string): string => {
			const out = transitionalPart(encodeUtf8(xml))

			return decodeUtf8(out, 0, out.length)
		}

		it("converts DrawingML percentages and universal measures as before", () => {
			const out = transitional(
				`<p:sld xmlns:p="${STRICT_P}" xmlns:a="${STRICT_A}"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="1in" y="2.5cm"/><a:ext cx="914400" cy="72pt"/></a:xfrm>` +
					'<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75%"/><a:lumOff val="-12.5%"/></a:schemeClr></a:solidFill>' +
					'<a:gradFill><a:gsLst><a:gs pos="50%"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100%"><a:scrgbClr r="50%" g="0%" b="25%"/></a:gs></a:gsLst>' +
					'<a:fillToRect l="50%" t="50%" r="50%" b="50%"/></a:gradFill><a:ln w="1pt"><a:miter lim="800%"/></a:ln></p:spPr>' +
					'<p:txBody><a:bodyPr lIns="0.1in"><a:normAutofit fontScale="92.5%" lnSpcReduction="10%"/></a:bodyPr><a:p><a:pPr marL="0.5in"><a:buSzPct val="100%"/></a:pPr>' +
					'<a:r><a:rPr baseline="30%"/><a:t>100%</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
			)

			expect(out).toContain('<a:off x="914400" y="900000"/><a:ext cx="914400" cy="914400"/>')
			expect(out).toContain('<a:lumMod val="75000"/><a:lumOff val="-12500"/>')
			expect(out).toContain('<a:gs pos="50000">')
			expect(out).toContain('<a:fillToRect l="50000" t="50000" r="50000" b="50000"/>')
			expect(out).toContain('<a:scrgbClr r="50000" g="0" b="25000"/>')
			expect(out).toContain('<a:ln w="12700"><a:miter lim="800000"/></a:ln>')
			expect(out).toContain('<a:bodyPr lIns="91440"><a:normAutofit fontScale="92500" lnSpcReduction="10000"/>')
			expect(out).toContain('<a:pPr marL="457200"><a:buSzPct val="100000"/>')
			expect(out).toContain('<a:rPr baseline="30000"/><a:t>100%</a:t>')
			expect(out).toContain('<a:schemeClr val="accent1">')
		})

		it("leaves names, descriptions and other text attributes that read as a percentage or measure as they are", () => {
			const out = transitional(
				`<p:sld xmlns:p="${STRICT_P}" xmlns:a="${STRICT_A}"><p:cSld name="50%"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="100%" descr="5in" title="12pt"/>` +
					'<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:pPr><a:buChar char="%"/></a:pPr><a:r><a:rPr><a:latin typeface="2in"/></a:rPr><a:t>x</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
			)

			expect(out).toContain('<p:cSld name="50%">')
			expect(out).toContain('<p:cNvPr id="2" name="100%" descr="5in" title="12pt"/>')
			expect(out).toContain('<a:latin typeface="2in"/>')
		})

		it("gives an element or attribute named after an Object prototype key no conversion", () => {
			const out = transitional(
				`<p:sld xmlns:p="${STRICT_P}" xmlns:a="${STRICT_A}"><p:cSld><p:spTree><a:constructor val="50%"/><a:__proto__ val="50%"/>` +
					'<a:off constructor="1in" toString="50%" x="1in" y="0"/></p:spTree></p:cSld></p:sld>'
			)

			expect(out).toContain('<a:constructor val="50%"/><a:__proto__ val="50%"/>')
			expect(out).toContain('<a:off constructor="1in" toString="50%" x="914400" y="0"/>')
		})

		it("strips the percent sign of chart percentages, never scaling them, and keeps number formats", () => {
			const out = transitional(
				`<c:chartSpace xmlns:c="${STRICT_C}" xmlns:a="${STRICT_A}"><c:chart><c:plotArea><c:barChart><c:gapWidth val="150%"/><c:overlap val="-20%"/>` +
					'<c:ser><c:spPr><a:solidFill><a:srgbClr val="4472C4"><a:alpha val="50%"/></a:srgbClr></a:solidFill></c:spPr>' +
					'<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/></c:dLbls></c:ser></c:barChart>' +
					'<c:valAx><c:numFmt formatCode="0.0%" sourceLinked="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>'
			)

			expect(out).toContain('<c:gapWidth val="150"/><c:overlap val="-20"/>')
			expect(out).toContain('<a:alpha val="50000"/>')
			expect(out).toContain('<c:numFmt formatCode="0%" sourceLinked="0"/>')
			expect(out).toContain('<c:numFmt formatCode="0.0%" sourceLinked="1"/>')
		})
	})

	describe.skipIf(PRESENT.length === 0)("over the corpus", () => {
		it("rewrites every deck: it reopens with the same slides, shapes and text", { timeout: budget(600_000) }, async () => {
			const failures: string[] = []
			let written = 0

			if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

			for (const file of PRESENT) {
				const opened = await openDeck(new Uint8Array(readFileSync(join(CORPUS_DIR, file.path))))
				let out: Uint8Array

				try {
					out = await fresh(opened.deck, opened.source)
				} catch (error) {
					failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)

					continue
				}

				let back: Awaited<ReturnType<typeof openDeck>>

				try {
					back = await openDeck(out)
				} catch (error) {
					failures.push(`${file.path}: reopen ${error instanceof Error ? error.message : String(error)}`)

					continue
				}

				if (back.deck.slides.length !== opened.deck.slides.length)
					failures.push(`${file.path}: ${String(back.deck.slides.length)} slides`)

				for (let index = 0; index < opened.deck.slides.length; index++) {
					const before = summary(slideNode(opened, index).shapes)
					const after = summary(slideNode(back, index).shapes)

					if (JSON.stringify(before) !== JSON.stringify(after)) {
						failures.push(`${file.path}: slide ${String(index + 1)} differs`)

						break
					}
				}

				if (OUT !== undefined) writeFileSync(join(OUT, `fresh__${basename(file.path)}`), out)

				written++
			}

			expect(failures).toEqual([])
			expect(written).toBe(PRESENT.length)
		})
	})
})
