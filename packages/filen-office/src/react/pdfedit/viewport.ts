import type { PdfViewport } from "../../dom/pdf/index"

// pdf.js's page viewport (PageViewport) for a page the editor's engine knows by its size alone: the same transform from
// the page's bottom-left user space to the view, so the text layer, links, find and a host's overlay place things on
// either engine's pages alike. The engine's pages carry their own /Rotate and crop already: the view box is
// [0, 0, width, height] and the rotation the view's own.

type Point = [number, number]

function apply(point: Point, matrix: readonly number[]): Point {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix

	return [point[0] * a + point[1] * c + e, point[0] * b + point[1] * d + f]
}

function applyInverse(point: Point, matrix: readonly number[]): Point {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix
	const determinant = a * d - b * c

	return [((point[0] - e) * d - (point[1] - f) * c) / determinant, (-(point[0] - e) * b + (point[1] - f) * a) / determinant]
}

export interface PageViewportParams {
	readonly viewBox: readonly [number, number, number, number]
	readonly scale: number
	readonly rotation: number
	readonly offsetX?: number
	readonly offsetY?: number
	readonly dontFlip?: boolean
}

export class PageViewport implements PdfViewport {
	viewBox: number[]
	userUnit = 1
	scale: number
	rotation: number
	offsetX: number
	offsetY: number
	transform: number[]
	width: number
	height: number
	private readonly dontFlip: boolean

	constructor(params: PageViewportParams) {
		const { viewBox, scale } = params
		const offsetX = params.offsetX ?? 0
		const offsetY = params.offsetY ?? 0
		const dontFlip = params.dontFlip === true
		const turn = ((params.rotation % 360) + 360) % 360
		const centerX = (viewBox[2] + viewBox[0]) / 2
		const centerY = (viewBox[3] + viewBox[1]) / 2
		if (turn % 90 !== 0) throw new RangeError("the rotation must be a multiple of 90 degrees")

		const [a, b, c0, d0] = turn === 90 ? [0, 1, 1, 0] : turn === 180 ? [-1, 0, 0, 1] : turn === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1]
		const c = dontFlip ? -c0 : c0
		const d = dontFlip ? -d0 : d0

		const sideways = a === 0
		const offsetCanvasX = Math.abs((sideways ? centerY - viewBox[1] : centerX - viewBox[0]) * scale) + offsetX
		const offsetCanvasY = Math.abs((sideways ? centerX - viewBox[0] : centerY - viewBox[1]) * scale) + offsetY

		this.viewBox = [...viewBox]
		this.scale = scale
		this.rotation = params.rotation
		this.offsetX = offsetX
		this.offsetY = offsetY
		this.dontFlip = dontFlip
		this.transform = [
			a * scale,
			b * scale,
			c * scale,
			d * scale,
			offsetCanvasX - a * scale * centerX - c * scale * centerY,
			offsetCanvasY - b * scale * centerX - d * scale * centerY
		]
		this.width = (sideways ? viewBox[3] - viewBox[1] : viewBox[2] - viewBox[0]) * scale
		this.height = (sideways ? viewBox[2] - viewBox[0] : viewBox[3] - viewBox[1]) * scale
	}

	get rawDims(): { readonly pageWidth: number; readonly pageHeight: number; readonly pageX: number; readonly pageY: number } {
		const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = this.viewBox

		return { pageWidth: x1 - x0, pageHeight: y1 - y0, pageX: x0, pageY: y0 }
	}

	clone(
		params: {
			scale?: number | undefined
			rotation?: number | undefined
			offsetX?: number | undefined
			offsetY?: number | undefined
			dontFlip?: boolean | undefined
		} = {}
	): PageViewport {
		const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = this.viewBox

		return new PageViewport({
			viewBox: [x0, y0, x1, y1],
			scale: params.scale ?? this.scale,
			rotation: params.rotation ?? this.rotation,
			offsetX: params.offsetX ?? this.offsetX,
			offsetY: params.offsetY ?? this.offsetY,
			dontFlip: params.dontFlip ?? this.dontFlip
		})
	}

	convertToViewportPoint(x: number, y: number): unknown[] {
		return apply([x, y], this.transform)
	}

	convertToPdfPoint(x: number, y: number): unknown[] {
		return applyInverse([x, y], this.transform)
	}
}
