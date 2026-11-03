import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { buildPptx } from "./pptxFixtures"

// A slide size change that moves content and a group whose member is written as its source: an ODP group has no
// transform of its own (ODF 1.3 Part 3 §10.3.15 draw:g), so the member's own box would have to be rewritten and the
// change is refused as locked; a pptx group carries its members by its transform (ECMA-376 §20.1.7.5 chOff/chExt),
// so the member follows without being rewritten.

const sp = (id: number, name: string, x: number, y: number) =>
	`<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr></p:sp>`
const GROUP =
	'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="5000000" cy="1000000"/><a:chOff x="1000000" y="1000000"/><a:chExt cx="5000000" cy="1000000"/></a:xfrm></p:grpSpPr>' +
	sp(3, "Left", 1_000_000, 1_000_000) +
	sp(4, "Kept", 4_000_000, 1_000_000) +
	"</p:grpSp>"

async function session(format: "odp" | "pptx") {
	const pptx = buildPptx({ slides: [{ shapes: GROUP }] })

	if (format === "pptx") return driveSession(pptx, "pptx")

	const odp = await freshFromPptx(pptx)

	if (!("bytes" in odp)) throw new Error(JSON.stringify(odp))

	return driveSession(odp.bytes)
}

async function keep(d: Awaited<ReturnType<typeof session>>): Promise<void> {
	await review(d.context, d.session.deck.slides[0] as SlideRef)

	const node = d.session.deck.nodes.get(d.session.deck.slides[0] as SlideRef) as SlideNode
	const group = node.shapes.find(shape => shape.children !== undefined) as ShapeNode
	const member = group.children?.find(shape => shape.name === "Kept") as ShapeNode

	// Written as its source, its box not writable by attributes.
	member.lock = "gate"
}

const SIZE: DeckOp = { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, type: "screen4x3", scale: "ensureFit" }

describe("a slide size change and a group member written as its source", () => {
	it("is refused in an ODP", async () => {
		const d = await session("odp")

		await keep(d)

		expect(await d.command(SIZE)).toMatchObject({ ok: false, refusal: "locked" })
	})

	it("carries the member by the group's transform in a pptx", async () => {
		const d = await session("pptx")

		await keep(d)

		expect(await d.command(SIZE)).toMatchObject({ ok: true })
	})
})
