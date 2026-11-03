import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { freshPptx } from "../core/pptx/write/fresh"
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
