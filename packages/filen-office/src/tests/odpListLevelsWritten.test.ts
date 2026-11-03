import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { reopened } from "./modelVsFile"
import { driveSession } from "./odpWriteDrive"

// A bulleted list an ODP save writes anew (here every text body, after a scaled slide size change) is written in the
// form LibreOffice Impress reads: list levels placed by text:space-before and text:min-label-width (Impress has no
// label-alignment mode), and a bullet's size as its text properties' fo:font-size (Impress ignores
// text:bullet-relative-size and draws a bullet without one tiny). Read back, its indents and bullet sizes are the
// session's.

const LIST =
	'<text:list-style style:name="L9"><text:list-level-style-bullet text:level="1" text:bullet-char="■">' +
	'<style:list-level-properties text:space-before="0in" text:min-label-width="0.5in"/>' +
	'<style:text-properties fo:color="#a0558f" fo:font-family="Arial" fo:font-size="100%"/></text:list-level-style-bullet>' +
	'<text:list-level-style-bullet text:level="2" text:bullet-char="■">' +
	'<style:list-level-properties text:space-before="0.5in" text:min-label-width="0.5in"/>' +
	'<style:text-properties fo:color="#a0558f" fo:font-family="Arial" fo:font-size="80%"/></text:list-level-style-bullet></text:list-style>'

const SOURCE = odpBytes({
	automatic: LIST + '<style:style style:name="P9" style:family="paragraph"><style:text-properties fo:font-size="24pt"/></style:style>',
	body:
		'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Body" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="10cm">' +
		'<draw:text-box><text:list text:style-name="L9"><text:list-item><text:p text:style-name="P9">One</text:p>' +
		'<text:list><text:list-item><text:p text:style-name="P9">Two</text:p></text:list-item></text:list></text:list-item>' +
		"</text:list></draw:text-box></draw:frame></draw:page>"
})

function bodyOf(shapes: readonly ShapeNode[]): ShapeNode {
	return shapes.find(shape => shape.name === "Body") as ShapeNode
}

describe("a bulleted ODP list written anew", () => {
	it("is written in Impress's list form and reads back as the session has it", async () => {
		const d = await driveSession(SOURCE, "odp")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const before = bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs.map(p => p.pPr) ?? []
		const size = {
			family: "design",
			kind: "setSize",
			cx: d.session.deck.size.cx / 2,
			cy: d.session.deck.size.cy / 2,
			scale: "ensureFit"
		} as DeckOp

		expect((await d.command(size)).ok).toBe(true)

		// Indents scale with the text (half the size here), as PowerPoint's Ensure Fit scales them.
		const scaled = bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs.map(p => p.pPr) ?? []

		expect(before.some(pPr => (pPr.marL ?? 0) > 0)).toBe(true)

		for (const [at, pPr] of before.entries()) {
			expect(scaled[at]?.marL).toBe(pPr.marL === undefined ? undefined : Math.round(pPr.marL / 2))
			expect(scaled[at]?.indent).toBe(pPr.indent === undefined ? undefined : Math.round(pPr.indent / 2))
		}

		const saved = await d.save()

		expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

		const content = strFromU8(unzipSync(saved.bytes as Uint8Array)["content.xml"] as Uint8Array)
		const levels = [...content.matchAll(/<text:list-level-style-bullet\b[\s\S]*?<\/text:list-level-style-bullet>/gu)].map(
			match => match[0]
		)

		expect(levels.length).toBeGreaterThan(0)

		for (const level of levels) {
			expect(level).not.toContain("label-alignment")
			expect(level).not.toContain("text:bullet-relative-size")
			expect(level).toMatch(/<style:list-level-properties [^>]*text:min-label-width="/u)
			expect(level).toMatch(/<style:text-properties [^>]*fo:font-size="\d+%"/u)
		}

		const again = await reopened(saved.bytes as Uint8Array, "odp")
		const first = again.session.deck.slides[0] as SlideRef

		await review(again.context, first)

		const after = bodyOf(again.session.deck.nodes.get(first)?.shapes ?? []).text?.paragraphs.map(p => p.pPr)

		const model = bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs.map(p => p.pPr)

		expect(after?.length).toBe(model?.length)

		for (const [at, pPr] of (after ?? []).entries()) {
			const want = model?.[at]

			expect(pPr.marL).toBe(want?.marL)
			expect(pPr.indent).toBe(want?.indent)
			expect(pPr.buSz).toEqual(want?.buSz)
			expect(pPr.bullet).toEqual(want?.bullet)
		}
	})
})

// Microsoft's ODP export places a list paragraph by its own margin and a hanging text-indent over a level of
// min-label-width alone: LibreOffice starts the label where the first line starts (margin plus indent), the text a
// label width on.
describe("an ODP list paragraph with its own hanging indent", () => {
	it("reads its label at the first line's start and its text a label width on", async () => {
		const d = await driveSession(
			odpBytes({
				automatic:
					'<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="■">' +
					'<style:list-level-properties text:space-before="0in" text:min-label-width="0.5in"/>' +
					'<style:text-properties fo:font-size="100%"/></text:list-level-style-bullet></text:list-style>' +
					'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.5in" fo:text-indent="-0.5in"/></style:style>',
				body:
					'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Body" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="10cm">' +
					'<draw:text-box><text:list text:style-name="L1"><text:list-item><text:p text:style-name="P1">One</text:p></text:list-item></text:list>' +
					"</draw:text-box></draw:frame></draw:page>"
			}),
			"odp"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const pPr = bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs[0]?.pPr

		expect(pPr?.marL).toBe(457_200)
		expect(pPr?.indent).toBe(-457_200)
		expect(pPr?.buSz).toBe("text")
	})
})

// A list whose style names no level (Microsoft's export writes <text:list-style style:name="…"/> for table cells'
// lists): LibreOffice 7.5 gives it its default bullets (measured: saved again, it writes each level as "●" in OpenSymbol
// at 45%, 0.6 cm a level, a 0.6 cm label), so the reader does, and a save keeps them.
describe("an ODP list whose style names no level", () => {
	it("reads LibreOffice's default bullets", async () => {
		const d = await driveSession(
			odpBytes({
				automatic: '<text:list-style style:name="L0"/>',
				body:
					'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Body" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="10cm">' +
					'<draw:text-box><text:list text:style-name="L0"><text:list-item><text:p>One</text:p>' +
					"<text:list><text:list-item><text:p>Two</text:p></text:list-item></text:list></text:list-item></text:list>" +
					"</draw:text-box></draw:frame></draw:page>"
			}),
			"odp"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const [one, two] = bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs.map(p => p.pPr) ?? []

		expect(one).toMatchObject({
			bullet: { kind: "char", char: "●" },
			buSz: { pct: 45_000 },
			buFont: { typeface: "OpenSymbol" },
			marL: 216_000,
			indent: -216_000
		})
		expect(two).toMatchObject({ bullet: { kind: "char", char: "●" }, marL: 432_000, indent: -216_000 })
	})
})

// A list naming a list style the document doesn't define: LibreOffice draws it as one whose style names no level
// (measured on lo__tdf96708 with the missing style added empty: pixel-identical), not with the master's outline.
describe("an ODP list naming a missing list style", () => {
	it("reads LibreOffice's default bullets", async () => {
		const d = await driveSession(
			odpBytes({
				body:
					'<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="Body" svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="10cm">' +
					'<draw:text-box><text:list text:style-name="Missing"><text:list-item><text:p>One</text:p></text:list-item></text:list>' +
					"</draw:text-box></draw:frame></draw:page>"
			}),
			"odp"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		expect(bodyOf(d.session.deck.nodes.get(slide)?.shapes ?? []).text?.paragraphs[0]?.pPr).toMatchObject({
			bullet: { kind: "char", char: "●" },
			marL: 216_000,
			indent: -216_000
		})
	})
})
