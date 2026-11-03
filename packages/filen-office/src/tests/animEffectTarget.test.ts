import { describe, expect, it } from "vitest"
import type { AnimTarget } from "../core/anim/model"
import { effectPreset, presetEffect } from "../core/anim/presets/effects/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { authoringHarness } from "./animAuthoringFixtures"

// An effect added for a shape the slide does not have (an id no shape carries, or none at all) is refused with a typed
// reason, never written as a target nothing names.

function effectOn(target: AnimTarget) {
	const preset = effectPreset("entr", 1)

	if (preset === undefined) throw new Error("no appear")

	return presetEffect({ preset, target, start: "click", aspect: 4 / 3 })
}

describe("an effect for a shape the slide does not have", () => {
	it.each([
		["an unknown id", { kind: "shape", shape: 999_999 }],
		["no id", { kind: "shape", shape: undefined as unknown as number }],
		["a paragraph of an unknown shape", { kind: "text", shape: 999_999, unit: "para", start: 0, end: 0 }]
	] as const)("is refused: %s", async (_, target) => {
		const h = await authoringHarness()
		const slide = await h.slide(0)
		const result = await h.command({
			family: "timing",
			kind: "addEffect",
			slide: slide.ref,
			effect: effectOn(target as AnimTarget)
		} as DeckOp)

		expect(result).toMatchObject({ ok: false, refusal: "notFound" })
		expect((await h.slide(0)).timing).toEqual(slide.timing)
	})
})
