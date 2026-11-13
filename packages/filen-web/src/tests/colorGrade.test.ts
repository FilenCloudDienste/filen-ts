import { describe, expect, it } from "vitest"
import { FRAGMENT_SOURCES } from "@/features/preview/imageEdit/worker/shaders"
import { GL_COLOR_GRADE, gradeUniforms, IDENTITY_GRADE, TRANSFER_BT709, TRANSFER_SRGB } from "@/lib/gl/colorGrade"

// The colour grade the image editor and the video editor share. No WebGL here: the sources are checked for how they
// compose (a duplicate declaration would fail to compile), the transfer switch for its default, and the uniform
// packing for the editors' units.

function declarations(source: string): string[] {
	return [...source.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map(match => match[1] ?? "")
}

function functions(source: string): string[] {
	return [...source.matchAll(/^(?:vec[234]|float|void|bool)\s+(\w+)\s*\(/gm)].map(match => match[1] ?? "")
}

describe("GL_COLOR_GRADE", () => {
	it("is composed into the image colour program once, with every uniform and function declared once", () => {
		const source = FRAGMENT_SOURCES.color
		const uniforms = declarations(source)
		const names = functions(source)

		expect(source.split(GL_COLOR_GRADE)).toHaveLength(2)
		expect(new Set(uniforms).size).toBe(uniforms.length)
		expect(new Set(names).size).toBe(names.length)
		expect(uniforms).toEqual(expect.arrayContaining(["u_adjustA", "u_adjustB", "u_adjustC", "u_transfer", "u_outSize"]))
	})

	it("declares u_outSize before the grade uses it", () => {
		const source = FRAGMENT_SOURCES.color

		expect(source.indexOf("uniform vec2 u_outSize;")).toBeLessThan(source.indexOf(GL_COLOR_GRADE))
	})

	it("decodes and re-encodes through the selected curve, sRGB unless BT.709 is asked for", () => {
		expect(TRANSFER_SRGB).toBe(0)
		expect(GL_COLOR_GRADE).toContain(`u_transfer == ${String(TRANSFER_BT709)} ? decodeBt709(v) : decodeSrgb(v)`)
		expect(GL_COLOR_GRADE).toContain(`u_transfer == ${String(TRANSFER_BT709)} ? encodeBt709(v) : encodeSrgb(v)`)
		expect(FRAGMENT_SOURCES.color).toContain("encodeTransfer(grade(decodeTransfer(texel.rgb), outPx))")
		// The sRGB pair the image editor always graded with (IEC 61966-2-1).
		expect(GL_COLOR_GRADE).toContain("mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v))")
		expect(GL_COLOR_GRADE).toContain("mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v))")
	})

	it("leaves the grade out of the copy and sharpen programs", () => {
		expect(FRAGMENT_SOURCES.copy).not.toContain("grade(")
		expect(FRAGMENT_SOURCES.sharpen).not.toContain("u_transfer")
	})
})

describe("gradeUniforms", () => {
	it("maps the editors' −100..100 units to the grade's −1..1", () => {
		expect(
			gradeUniforms({
				exposure: 50,
				brightness: -20,
				contrast: 10,
				highlights: -100,
				shadows: 100,
				warmth: 30,
				tint: -40,
				saturation: 5,
				vibrance: -5,
				vignette: 60
			})
		).toEqual({ adjustA: [0.5, -0.2, 0.1, -1], adjustB: [1, 0.3, -0.4, 0.05], adjustC: [-0.05, 0.6] })
	})

	it("is the identity at zero", () => {
		expect(
			gradeUniforms({
				exposure: 0,
				brightness: 0,
				contrast: 0,
				highlights: 0,
				shadows: 0,
				warmth: 0,
				tint: 0,
				saturation: 0,
				vibrance: 0,
				vignette: 0
			})
		).toEqual(IDENTITY_GRADE)
	})
})
