import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Xfrm } from "../core/presentation/model"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { saveEdits } from "./pptxWriteFixtures"

// A box an op sets must be whole (x, y, cx, cy, rot, flipH, flipV, finite and in range): a partial or broken one is
// refused as malformed with nothing applied, so no later save can be poisoned by it.

const BOX: Xfrm = { x: 100, y: 200, cx: 3000, cy: 400, rot: 0, flipH: false, flipV: false }

function deck(): Uint8Array {
	return buildPptx({ slides: [{ shapes: sp(2, "Box", undefined, xfrm(100, 200, 3000, 400), body(para("Words"))) }] })
}

describe("shape boxes", () => {
	const broken: readonly unknown[] = [
		{ x: 7000 },
		{ ...BOX, cx: Number.NaN },
		{ ...BOX, cy: -1 },
		{ ...BOX, rot: Number.POSITIVE_INFINITY },
		{ ...BOX, flipH: "yes" },
		{ ...BOX, x: 1e15 }
	]

	it("refuses a partial or broken box for one shape or several, applying nothing, and saves after", async () => {
		const h = await editHarness(deck())
		const slide = h.session.deck.slides[0] as never
		const before = JSON.stringify(shapeById((await h.slide(0)).shapes, 2)?.xfrm)

		for (const bad of broken) {
			const one = await h.command({ family: "shape", kind: "setXfrm", target: { slide, id: 2 }, xfrm: bad } as unknown as DeckOp)
			const many = await h.command({ family: "shape", kind: "setXfrms", slide, xfrms: [{ id: 2, xfrm: bad }] } as unknown as DeckOp)

			expect(one).toMatchObject({ ok: false, refusal: "malformed" })
			expect(many).toMatchObject({ ok: false, refusal: "malformed" })
		}

		expect(JSON.stringify(shapeById((await h.slide(0)).shapes, 2)?.xfrm)).toBe(before)

		const moved = await h.command({ family: "shape", kind: "setXfrm", target: { slide, id: 2 }, xfrm: { ...BOX, x: 500 } })

		expect(moved.ok).toBe(true)
		await expect(saveEdits(h, 1)).resolves.toBeInstanceOf(Uint8Array)
	})
})
