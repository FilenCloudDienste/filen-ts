import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { TIMING_XML } from "./animFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A build entry keeps what the model does not hold (uiExpand, advAuto, p:tmplLst): an untouched one stays its source
// span when the build list is written again, and an undo puts every effect op's timing back as the file had it, before
// a save and after one (node ids and build entries included).

const BLD =
	'<p:bldLst><p:bldP spid="3" grpId="0" uiExpand="1" build="p" advAuto="2000"><p:tmplLst><p:tmpl lvl="1"><p:tnLst><p:par><p:cTn id="99" fill="hold"/></p:par></p:tnLst></p:tmpl></p:tmplLst></p:bldP></p:bldLst>'

function deck(): Uint8Array {
	const timing = TIMING_XML.replace('<p:bldLst><p:bldP spid="3" grpId="0" build="p"/></p:bldLst>', BLD)

	if (timing === TIMING_XML) throw new Error("fixture changed")

	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					sp(4, "Box", undefined, xfrm(6000000, 1000000, 1000000, 1000000)),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}`
			}
		]
	})
}

const timingOf = async (bytes: Uint8Array): Promise<string | undefined> =>
	/<p:timing>.*<\/p:timing>/su.exec(text((await entriesOf(bytes)).get("ppt/slides/slide1.xml")))?.[0]

async function session() {
	const source = deck()
	const h = await driveSession(source, "pptx")
	const slide = async (): Promise<SlideNode> => {
		const parts = pptxParts(h.session.deck)
		const node = await parts?.slide(h.session.deck.slides[0] ?? (0 as never))

		if (node === undefined) throw new Error("no slide")

		return node as SlideNode
	}

	return { source, h, slide }
}

describe("build entries and exact timing undo", () => {
	it("keeps an untouched build's attributes and children when another shape gains an effect", async () => {
		const { h, slide } = await session()
		const node = await slide()
		const rows = slideEffects(node.timing)
		const op = addEffectsOp(node.ref, rows.kind === "effects" ? rows.rows : [], [{ id: 2 }], {
			preset: effectPreset("entr", 10) ?? (undefined as never),
			aspect: 4 / 3
		})

		if (op === undefined) throw new Error("no op")

		expect(await h.command(op)).toMatchObject({ ok: true })

		const saved = await h.save()

		expect(saved.result.kind).toBe("written")
		expect(await timingOf(saved.bytes ?? new Uint8Array())).toContain(BLD.slice("<p:bldLst>".length, -"</p:bldLst>".length))
	})

	const steps: readonly { readonly name: string; readonly op: (slide: SlideNode) => DeckOp }[] = [
		{ name: "remove", op: slide => ({ family: "timing", kind: "removeEffect", slide: slide.ref, node: 14 }) },
		{
			name: "retime",
			op: slide => ({ family: "timing", kind: "setEffectTiming", slide: slide.ref, node: 14, timing: { delayMs: 300 } })
		},
		{ name: "move", op: slide => ({ family: "timing", kind: "moveEffect", slide: slide.ref, node: 14, to: 0 }) }
	]

	for (const step of steps)
		for (const saveBetween of [false, true])
			it(`an undone ${step.name} saves the file's own timing (a save between: ${String(saveBetween)})`, async () => {
				const { source, h, slide } = await session()

				expect(await h.command(step.op(await slide()))).toMatchObject({ ok: true })

				if (saveBetween) expect((await h.save()).result.kind).toBe("written")

				expect(await h.undo()).toMatchObject({ ok: true })

				const saved = await h.save()

				expect(await timingOf(saved.bytes ?? source)).toBe(await timingOf(source))
			})
})
