import { describe, expect, it } from "vitest"
import { concatMatrix, IDENTITY_MATRIX, invertMatrix, transformPoint } from "../../core/pdfedit/matrix"

// The one set of affine helpers the editor's geometry (redaction, OCR, overlays, page copies) shares.

describe("PDF matrices", () => {
	it("composes in PDF order: the first matrix applies first", () => {
		const m = concatMatrix([2, 0, 0, 3, 5, 7], [0, 1, -1, 0, 10, 0])

		expect(transformPoint(m, 1, 1)).toEqual([0, 7])
		expect(concatMatrix(m, IDENTITY_MATRIX)).toEqual(m)
	})

	it("inverts, and gives null for a matrix that flattens the plane or is not finite", () => {
		const m = [2, 0.5, -1, 3, 10, -4] as const
		const inverse = invertMatrix(m)

		expect(inverse).not.toBeNull()

		concatMatrix(m, inverse ?? IDENTITY_MATRIX).forEach((value, index) => {
			expect(value).toBeCloseTo(IDENTITY_MATRIX[index] ?? Number.NaN, 9)
		})
		expect(invertMatrix([0, 0, 0, 0, 1, 1])).toBeNull()
		expect(invertMatrix([1e-7, 0, 0, 1e-7, 0, 0])).toBeNull()
		expect(invertMatrix([Number.POSITIVE_INFINITY, 0, 0, 1, 0, 0])).toBeNull()
	})
})
