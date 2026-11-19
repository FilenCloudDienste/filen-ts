import { describe, expect, it } from "vitest"
import { presetTransition, TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideRef } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { TIMING_XML } from "./animFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// What an inverse holds of the source is bytes of its own: the source reads answer views on a part's whole buffer,
// which a step held for the history's life would keep reachable after a save's rebase.

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					sp(4, "Box", undefined, xfrm(6000000, 1000000, 1000000, 1000000)),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition spd="slow"><p:fade/></p:transition>${TIMING_XML}`
			}
		]
	})
}

function heldBytesOf(value: unknown, out: Uint8Array[] = [], seen = new Set<object>()): Uint8Array[] {
	if (typeof value !== "object" || value === null || seen.has(value)) return out

	seen.add(value)

	if (value instanceof Uint8Array) {
		if (value.length > 0) out.push(value)

		return out
	}

	for (const item of Array.isArray(value) ? value : Object.values(value)) heldBytesOf(item, out, seen)

	return out
}

describe("an inverse's source bytes", () => {
	const cases: readonly (readonly [string, (slide: SlideRef) => DeckOp])[] = [
		["an effect's timing", slide => ({ family: "timing", kind: "setEffectTiming", slide, node: 10, timing: { delayMs: 300 } })],
		[
			"a transition",
			slide => ({
				family: "transition",
				kind: "set",
				slides: [slide],
				transition: presetTransition(TRANSITION_PRESETS[0] as (typeof TRANSITION_PRESETS)[number])
			})
		],
		["an animated shape's delete", slide => ({ family: "shape", kind: "delete", slide, shapes: [4] })]
	]

	for (const [name, op] of cases) {
		it(`of ${name} own their buffer`, async () => {
			const d = await driveSession(deck(), "pptx")
			const slide = d.session.deck.slides[0] as SlideRef

			expect(await d.command(op(slide))).toMatchObject({ ok: true })

			const step = sessionEdits(d.session).history.steps().at(-1)
			const held = heldBytesOf(step?.inverse.ops)

			expect(held.length).toBeGreaterThan(0)

			for (const bytes of held) expect(bytes.byteLength).toBe(bytes.buffer.byteLength)
		})
	}
})
