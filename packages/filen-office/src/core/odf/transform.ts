import { parseLength } from "./units"

// draw:transform (ODF 1.3 Part 3 §19.229): its transforms applied in the order written. LibreOffice's
// "rotate (a) translate (x y)" turns the box about its corner, then places that corner. DrawingML places the
// unrotated box (offset and extent) and turns it about its centre; decompose() converts one into the other.

// [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (points).
export type Matrix = [number, number, number, number, number, number]

// m after n.
export function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5]
	]
}

// draw:transform's calls in order, as /([a-zA-Z]+)\s*\(([^)]*)\)/g reads them, in time linear in the value: a name
// starts where a run of letters does, and its arguments end at the next ")" (none: no later call closes either).
export function transformCalls(transform: string): { readonly name: string; readonly args: string }[] {
	const out: { name: string; args: string }[] = []
	const opening = /(?<![a-zA-Z])([a-zA-Z]+)\s*\(/gu

	for (let match = opening.exec(transform); match !== null; match = opening.exec(transform)) {
		const from = match.index + match[0].length
		const close = transform.indexOf(")", from)

		if (close < 0) break

		out.push({ name: match[1] ?? "", args: transform.slice(from, close) })
		opening.lastIndex = close + 1
	}

	return out
}

// draw:transform as one matrix (points), the transforms applied in the order written.
export function transformMatrix(transform: string): Matrix | undefined {
	let out: Matrix = [1, 0, 0, 1, 0, 0]
	let found = false

	for (const call of transformCalls(transform)) {
		const name = call.name.toLowerCase()
		const args = call.args
			.trim()
			.split(/[\s,]+/u)
			.filter(item => item !== "")
		let step: Matrix | undefined

		switch (name) {
			case "rotate": {
				const angle = Number(args[0] ?? "0")

				if (!Number.isFinite(angle)) return undefined

				// Counter-clockwise on the page (y down): x' = x cos + y sin, y' = −x sin + y cos.
				step = [Math.cos(angle), -Math.sin(angle), Math.sin(angle), Math.cos(angle), 0, 0]
				break
			}
			case "translate": {
				const x = parseLength(args[0]) ?? (Number(args[0] ?? "0") / 1000 / 2.54) * 72
				const y = parseLength(args[1] ?? "0") ?? (Number(args[1] ?? "0") / 1000 / 2.54) * 72

				step = [1, 0, 0, 1, Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0]
				break
			}
			case "scale": {
				const sx = Number(args[0] ?? "1")
				const sy = Number(args[1] ?? args[0] ?? "1")

				step = [Number.isFinite(sx) ? sx : 1, 0, 0, Number.isFinite(sy) ? sy : 1, 0, 0]
				break
			}
			case "skewx": {
				const angle = Number(args[0] ?? "0")

				step = [1, 0, Number.isFinite(angle) ? Math.tan(angle) : 0, 1, 0, 0]
				break
			}
			case "skewy": {
				const angle = Number(args[0] ?? "0")

				step = [1, Number.isFinite(angle) ? Math.tan(angle) : 0, 0, 1, 0, 0]
				break
			}
			case "matrix": {
				const values = args.map(arg => parseLength(arg) ?? Number(arg))

				if (values.length === 6 && values.every(Number.isFinite)) step = values as Matrix
				break
			}
			default:
				break
		}

		if (step !== undefined) {
			out = multiply(step, out)
			found = true
		}
	}

	return found ? out : undefined
}

export interface Decomposed {
	// The unrotated box (points), its clockwise rotation about the centre in [0, 360) degrees, and whether it is
	// mirrored (a vertical flip of the box before the turn).
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	readonly degrees: number
	readonly mirrored: boolean
	// Whether that is exact: the matrix keeps right angles (no skew, no unequal scale under a turn).
	readonly exact: boolean
}

// A box in points under `matrix` as DrawingML's offset, extent and rotation; the box's own scale (a "scale" step,
// or a mirror) folds into its size and flip.
export function decompose(
	box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	matrix: Matrix
): Decomposed {
	const sx = Math.hypot(matrix[0], matrix[1])
	const sy = Math.hypot(matrix[2], matrix[3])
	const w = box.w * sx
	const h = box.h * sy
	const centerX = matrix[0] * (box.x + box.w / 2) + matrix[2] * (box.y + box.h / 2) + matrix[4]
	const centerY = matrix[1] * (box.x + box.w / 2) + matrix[3] * (box.y + box.h / 2) + matrix[5]
	const degrees = ((((Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI) % 360) + 360) % 360

	return {
		x: centerX - w / 2,
		y: centerY - h / 2,
		w,
		h,
		degrees,
		mirrored: matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0,
		exact: Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) <= 1e-9 * Math.max(1, sx * sy)
	}
}
