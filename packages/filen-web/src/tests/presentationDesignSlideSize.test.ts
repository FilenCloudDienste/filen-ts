import { describe, expect, it } from "vitest"
import { SLIDE_SIZES, slideSizeName } from "@filen/office/core/presentation"
import { defaultScale, emuToUnit, typedLength } from "@/features/presentation/components/design/design.logic"

// The Slide size dialog shows lengths rounded to two decimals; what it applies is the preset's exact EMU, and a typed
// length within half the last shown digit of a preset's is that preset's.

describe("slide size lengths", () => {
	for (const unit of ["cm", "in"] as const)
		for (const [name, size] of Object.entries(SLIDE_SIZES))
			it(`reads ${name} back from its rounded ${unit} as the preset`, () => {
				const cx = typedLength(emuToUnit(size.cx, unit), unit)
				const cy = typedLength(emuToUnit(size.cy, unit), unit)

				expect({ cx, cy, name: slideSizeName({ cx, cy, ...("type" in size ? { type: size.type } : {}) }) }).toEqual({
					cx: size.cx,
					cy: size.cy,
					name
				})
			})

	it("keeps a typed length further than half a shown digit from every preset as typed", () => {
		expect(typedLength("33.86", "cm")).toBe(12_189_600)
		expect(typedLength("13.33", "in")).toBe(12_192_000)
		expect(typedLength("13.32", "in")).toBe(12_179_808)
		expect(typedLength("abc", "in")).toBeNaN()
	})

	it("centres content on a larger slide and fits it on a smaller one, keeping an unchanged size as it is", () => {
		const standard = SLIDE_SIZES.standard
		const widescreen = SLIDE_SIZES.widescreen

		expect(defaultScale(standard, widescreen)).toBe("ensureFit")
		expect(defaultScale(widescreen, standard)).toBe("ensureFit")
		expect(defaultScale(widescreen, { cx: widescreen.cx, cy: widescreen.cy })).toBe("none")
	})
})
