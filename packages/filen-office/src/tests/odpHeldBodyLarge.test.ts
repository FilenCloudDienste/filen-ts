import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// An ODP body whose paragraphs effects target, one paragraph holding more child elements than a call can take as
// arguments: edited, saved and undone, the undo takes the held markup back like any other.

const CHILDREN = 130_000

function animatedDeck(children: number): Uint8Array {
	return odpBytes({
		body:
			'<draw:page draw:name="one" draw:master-page-name="M"><draw:frame presentation:class="subtitle" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="10cm"><draw:text-box>' +
			'<text:p xml:id="id1" text:id="id1">First</text:p><text:p xml:id="id2" text:id="id2">Second</text:p>' +
			`<text:p xml:id="id3" text:id="id3">Third${"<text:span>a</text:span>".repeat(children)}</text:p>` +
			'</draw:text-box></draw:frame><anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence">' +
			["id1", "id2", "id3"]
				.map(
					id =>
						'<anim:par smil:begin="next"><anim:par smil:begin="0s"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-appear">' +
						`<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="${id}" anim:sub-item="text" smil:attributeName="visibility" smil:to="visible"/></anim:par></anim:par></anim:par>`
				)
				.join("") +
			"</anim:seq></anim:par></draw:page>"
	})
}

describe("an ODP body with a paragraph of very many elements, edited, saved and undone", () => {
	it("undoes", { timeout: 60_000 }, async () => {
		const d = await driveSession(animatedDeck(CHILDREN), "odp")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide, { comments: false })

		const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.text !== undefined) as ShapeNode
		const body = shape.text as TextBody
		const edited: TextBody = {
			...body,
			paragraphs: body.paragraphs.map((paragraph, k) =>
				k === 0 ? { ...paragraph, runs: [...paragraph.runs, { kind: "r", text: "Z", rPr: {} }] } : paragraph
			)
		}

		expect(await d.command({ family: "text", kind: "setText", target: { slide, id: shape.id }, body: edited })).toMatchObject({
			ok: true
		})
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
	})
})
