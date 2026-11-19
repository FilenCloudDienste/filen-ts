import { describe, expect, it } from "vitest"
import { bodyHasText, type Run, type TextBody } from "../core/presentation/model"

function bodyOf(...paragraphs: Run[][]): TextBody {
	return { bodyPr: {}, paragraphs: paragraphs.map(runs => ({ pPr: {}, runs })) }
}

describe("bodyHasText", () => {
	it("is false for a body with no paragraphs, line breaks only or empty runs only", () => {
		expect(bodyHasText(bodyOf())).toBe(false)
		expect(bodyHasText(bodyOf([]))).toBe(false)
		expect(bodyHasText(bodyOf([{ kind: "br", rPr: {} }], [{ kind: "br", rPr: {} }]))).toBe(false)
		expect(
			bodyHasText(bodyOf([{ kind: "r", text: "", rPr: {} }], [{ kind: "fld", type: "slidenum", id: "{1}", text: "", rPr: {} }]))
		).toBe(false)
	})

	it("is true for one character in any paragraph", () => {
		expect(bodyHasText(bodyOf([{ kind: "br", rPr: {} }], [{ kind: "r", text: "x", rPr: {} }]))).toBe(true)
		expect(bodyHasText(bodyOf([{ kind: "fld", type: "slidenum", id: "{1}", text: "3", rPr: {} }]))).toBe(true)
	})
})
