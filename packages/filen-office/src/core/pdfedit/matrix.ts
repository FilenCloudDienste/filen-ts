// PDF/MuPDF affine transforms [a, b, c, d, e, f] (row vectors): a point (x, y) maps to (a x + c y + e, b x + d y + f),
// and concatMatrix(m, n) applies m, then n.

export type PdfMatrix = readonly [number, number, number, number, number, number]

export const IDENTITY_MATRIX: PdfMatrix = [1, 0, 0, 1, 0, 0]

export function concatMatrix(m: PdfMatrix, n: PdfMatrix): PdfMatrix {
	return [
		m[0] * n[0] + m[1] * n[2],
		m[0] * n[1] + m[1] * n[3],
		m[2] * n[0] + m[3] * n[2],
		m[2] * n[1] + m[3] * n[3],
		m[4] * n[0] + m[5] * n[2] + n[4],
		m[4] * n[1] + m[5] * n[3] + n[5]
	]
}

// The inverse, or null for a matrix that flattens the plane (or is not finite).
export function invertMatrix(m: PdfMatrix): PdfMatrix | null {
	const det = m[0] * m[3] - m[1] * m[2]

	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null

	const a = m[3] / det
	const b = -m[1] / det
	const c = -m[2] / det
	const d = m[0] / det

	return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d]
}

export function transformPoint(m: PdfMatrix, x: number, y: number): readonly [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
