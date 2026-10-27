import { describe, expect, it } from "vitest"
import { ATTRIBUTE_MATRIX, attributeFromOdf, compileFormula, ease, hslToRgba, lerpHsl, rgbToHsl } from "../core/anim/attributes"
import { compile, instantiate } from "../core/anim/timegraph"
import { BUDGETS, TimingBuilder, animatedSlide, shape } from "./animFixtures"

// The attribute matrix and its value machinery: routes, formulas, SMIL easing and colour interpolation, and the
// samples of colour emphases equal to the formulas.

const RED = 0xff0000ff
const BLUE = 0x0000ffff

describe("the attribute matrix", () => {
	it("routes every animatable attribute and names it in ODF", () => {
		expect(ATTRIBUTE_MATRIX["ppt_x"]).toMatchObject({ route: "transform", channel: "x", odf: "x" })
		expect(ATTRIBUTE_MATRIX["style.visibility"]?.route).toBe("visibility")
		expect(ATTRIBUTE_MATRIX["style.fontSize"]?.route).toBe("fontSize")
		expect(ATTRIBUTE_MATRIX["fill.color"]).toMatchObject({ route: "dom", dom: "fill" })
		expect(ATTRIBUTE_MATRIX["imageData.grayscale"]?.route).toBe("image")
		expect(attributeFromOdf("rotate")).toBe("style.rotation")
		expect(attributeFromOdf("CharColor")).toBe("style.color")
	})

	it("evaluates time-animate formulas with the shape's geometry and $", () => {
		const vars = Float64Array.of(0.25, 0.4, 0.5, 0.2, 0.1)

		expect(compileFormula("#ppt_x")?.(vars)).toBeCloseTo(0.4)
		expect(compileFormula("1+#ppt_h/2")?.(vars)).toBeCloseTo(1.05)
		expect(compileFormula("#ppt_x+(cos(-2*pi*(1-$))*-#ppt_x-sin(-2*pi*(1-$))*(1-#ppt_y))*(1-$)")?.(vars)).toBeCloseTo(
			0.4 + (Math.cos(-2 * Math.PI * 0.75) * -0.4 - Math.sin(-2 * Math.PI * 0.75) * 0.5) * 0.75
		)
		expect(compileFormula("2^3^2")?.(vars)).toBe(512)
		expect(compileFormula("max(1,-2)+min(3,abs(-4))")?.(vars)).toBe(4)
		expect(compileFormula("#ppt_x+")).toBeUndefined()
		expect(compileFormula("unknown(1)")).toBeUndefined()
	})

	it("eases with SMIL acceleration and deceleration", () => {
		expect(ease(0.5, 0, 0)).toBe(0.5)
		expect(ease(0, 0.5, 0.5)).toBe(0)
		expect(ease(1, 0.5, 0.5)).toBeCloseTo(1)
		expect(ease(0.5, 0.5, 0.5)).toBeCloseTo(0.5)
		expect(ease(0.25, 0.5, 0)).toBeCloseTo((0.25 * 0.25) / (2 * 0.5) / 0.75)
	})

	it("turns HSL hues the named way round (counter-clockwise at 0.25, 0.5, 0.75)", () => {
		// Red (0°) to blue (240°): clockwise is +240°, counter-clockwise −120°.
		for (const t of [0.25, 0.5, 0.75]) {
			expect(rgbToHsl(lerpHsl(RED, BLUE, t, "ccw")).h).toBeCloseTo((((0 - 120 * t) % 360) + 360) % 360, 0)
			expect(rgbToHsl(lerpHsl(RED, BLUE, t, "cw")).h).toBeCloseTo(240 * t, 0)
		}

		expect(hslToRgba({ h: 120, s: 1, l: 0.5 })).toBe(0x00ff00ff)
	})

	it("samples a Fill Color emphasis in HSL and a Font Color emphasis as the formula gives", () => {
		const b = new TimingBuilder()
		const fill = b.behavior(
			{
				type: "animClr",
				common: { target: { kind: "shape", shape: 2 }, attrNames: ["fill.color"] },
				clrSpc: "hsl",
				dir: "ccw",
				from: { kind: "srgb", rgb: "FF0000" },
				to: { kind: "srgb", rgb: "0000FF" }
			},
			{ dur: 1000 }
		)
		const font = b.behavior(
			{
				type: "animClr",
				common: { target: { kind: "shape", shape: 3 }, attrNames: ["style.color"] },
				clrSpc: "rgb",
				from: { kind: "srgb", rgb: "FF0000" },
				to: { kind: "srgb", rgb: "0000FF" }
			},
			{ dur: 1000 }
		)
		const tree = b.root([
			b.mainSeq([b.click([[0, [b.effect(2, { presetID: 1, presetClass: "emph", nodeType: "clickEffect" }, 0, [fill, font])]]])])
		])
		const t = instantiate(compile(animatedSlide(tree, [shape(2), shape(3)]), { shapes: Int32Array.of(2, 3) }, BUDGETS))

		t.fire({ kind: "slideBegin" }, 0)
		t.fire({ kind: "next" }, 0)

		for (const at of [0.25, 0.5, 0.75]) {
			const states = t.sample(at * 1000)

			expect(states[0]?.dom?.fill).toBe(lerpHsl(RED, BLUE, at, "ccw"))
		}

		expect(t.sample(500)[1]?.dom?.textColor).toBe(0x800080ff)
	})
})
