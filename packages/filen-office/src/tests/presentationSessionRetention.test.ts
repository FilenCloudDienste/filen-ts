import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { installTestRealm } from "./presentationExportFixtures"
import { liveHeap } from "./liveHeap"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// What a session holds across saves: the reading an ODP save's rebase replaced is let go at once (not at the next
// render), and the faces the session measured with stay prepared, so the page is not sent them again after every save.

const DECKS = {
	pptx: () =>
		buildPptx({
			slides: [
				{
					shapes: sp(
						2,
						"Title",
						undefined,
						`${xfrm(914400, 914400, 4572000, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("Text"))
					)
				}
			]
		}),
	odp: () =>
		odpBytes({
			body: page(
				'<draw:custom-shape draw:name="Box" svg:x="1cm" svg:y="1cm" svg:width="8cm" svg:height="2cm"><text:p>Text</text:p>' +
					'<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>'
			)
		})
} as const

function moved(
	shape: ShapeNode,
	by: number
): Extract<Parameters<Awaited<ReturnType<typeof driveSession>>["command"]>[0], { kind: "setXfrm" }> {
	const box = shape.xfrm

	if (box === undefined) throw new Error("no box")

	return { family: "shape", kind: "setXfrm", target: { slide: 0 as SlideRef, id: shape.id }, xfrm: { ...box, x: box.x + by } }
}

describe("a session across saves", () => {
	beforeAll(installTestRealm)
	afterAll(() => installPresentationRealm(undefined))

	for (const format of ["pptx", "odp"] as const) {
		it(`holds one ${format} reading across saves, and sends the page its faces once`, async () => {
			const events: { readonly type: string }[] = []
			const d = await driveSession(DECKS[format](), format, events)
			const [slide] = d.session.deck.slides
			const partsOf = (): object | undefined => (format === "pptx" ? pptxParts(d.session.deck) : odpParts(d.session.deck))

			if (slide === undefined) throw new Error("no slide")

			await viewCapability.render(d.context, [slide])

			const fonts = events.filter(event => event.type === "fonts").length
			const shape = d.session.deck.nodes.get(slide)?.shapes[0]

			if (shape === undefined) throw new Error("no shape")

			expect(fonts).toBeGreaterThan(0)

			const replaced = new WeakRef(partsOf() ?? {})

			for (let save = 1; save <= 2; save++) {
				expect(await d.command({ ...moved(shape, 12700 * save), target: { slide, id: shape.id } })).toMatchObject({ ok: true })
				expect((await d.save()).result.kind).toBe("written")
			}

			// A pptx rebase moves its reading onto the saved file in place; an ODP one reads the saved file anew.
			if (format === "pptx") expect(partsOf()).toBe(replaced.deref())
			else {
				expect(partsOf()).not.toBe(replaced.deref())
				await liveHeap()
				expect(replaced.deref()).toBeUndefined()
			}

			await viewCapability.render(d.context, [slide])
			expect(events.filter(event => event.type === "fonts")).toHaveLength(fonts)
		})
	}
})
