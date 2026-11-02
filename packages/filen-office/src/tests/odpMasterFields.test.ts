import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { renderSlideFor } from "../dom/presentation/engine/view"
import { selectable, slideShapes } from "../react/presentation/edit/selection"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { partsOf } from "./pptxWriteFixtures"

// A master's footer and page number an ODP slide shows are the master's frames (styles.xml), filled from the page's
// declarations: shapes of the slide's model that no edit of the slide can change (nor animate: the file could not name
// them). Every edit of one is refused as
// locked at command time (the editor says so), and the saved file keeps the master's.

const DECK = {
	automatic:
		'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:display-footer="true" presentation:display-page-number="true"/></style:style>',
	body:
		'<presentation:footer-decl presentation:name="ftr1">Footer text</presentation:footer-decl>' +
		'<draw:page draw:name="one" draw:style-name="dp1" draw:master-page-name="M" presentation:use-footer-name="ftr1"><draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame></draw:page>' +
		'<draw:page draw:name="two" draw:master-page-name="M"/>'
}

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

const decode = (bytes: Uint8Array | undefined): string => (bytes === undefined ? "" : new TextDecoder().decode(bytes))

describe("a master's footer and page number on an ODP slide", () => {
	it("refuses every edit of them as locked, and the saved file keeps the master's", async () => {
		const d = await driveSession(odpBytes(DECK), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first, { comments: false })

		const node = d.session.deck.nodes.get(first) as SlideNode
		const fields = node.shapes.filter(shape => shape.synthetic === true)

		expect(fields.map(shape => shape.lock)).toEqual(["master", "master"])

		for (const field of fields as ShapeNode[]) {
			const target = { slide: first, id: field.id }
			const box = field.xfrm ?? { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }
			const ops: DeckOp[] = [
				{ family: "text", kind: "setText", target, body: plain("Z") },
				{ family: "shape", kind: "setXfrm", target, xfrm: { ...box, x: box.x + 36_000 } },
				{ family: "shape", kind: "delete", slide: first, shapes: [field.id] }
			]
			const rows = slideEffects(node.timing)
			const effect = addEffectsOp(first, rows.kind === "effects" ? rows.rows : [], [{ id: field.id }], {
				preset: effectPreset("entr", 10) ?? (undefined as never),
				aspect: 4 / 3
			})

			if (effect !== undefined) ops.push(effect)

			for (const op of ops) expect(await d.command(op), `${op.family} ${op.kind}`).toMatchObject({ ok: false, refusal: "locked" })
		}

		// The editor offers none of them: a click, the marquee, Tab or Select All select only the slide's own shapes.
		const shown = slideShapes(await renderSlideFor(d.context, first))
		const offered = new Set(shown.filter(selectable).map(shape => shape.id))

		expect(fields.every(field => !offered.has(field.id))).toBe(true)
		expect(offered.size).toBeGreaterThan(0)

		// Something else, so the save writes.
		const title = node.shapes.find(shape => shape.synthetic !== true && shape.text !== undefined) as ShapeNode

		expect((await d.command({ family: "text", kind: "setText", target: { slide: first, id: title.id }, body: plain("New") })).ok).toBe(
			true
		)

		const saved = await d.save()
		const parts = await partsOf(saved.bytes as Uint8Array)

		expect(decode(parts.get("content.xml"))).toContain("Footer text")
		expect(decode(parts.get("content.xml"))).not.toContain(">Z<")
	})
})
