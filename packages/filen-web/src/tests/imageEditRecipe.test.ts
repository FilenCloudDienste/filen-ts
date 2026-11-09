import { describe, expect, it } from "vitest"
import {
	aspectRect,
	clampCrop,
	composeOrientation,
	geometryMatrix,
	identityRecipe,
	invertMatrix3,
	isGeometryOnly,
	isIdentity,
	mapMarkupPoint,
	outputSize,
	sourceRectForTile,
	straightenScale,
	transformPoint,
	turnedSize
} from "@/features/preview/imageEdit/lib/recipe"
import type { Geometry, ImageEditRecipe, Orientation, QuarterTurns } from "@/features/preview/imageEdit/types"

// ── Pixel reference ──────────────────────────────────────────────────────────

interface Grid {
	w: number
	h: number
	px: number[]
}

function at(grid: Grid, x: number, y: number): number {
	const value = grid.px[y * grid.w + x]

	if (value === undefined) {
		throw new Error("out of grid")
	}

	return value
}

function make(w: number, h: number, pick: (x: number, y: number) => number): Grid {
	const px: number[] = []

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			px.push(pick(x, y))
		}
	}

	return { w, h, px }
}

const rotateClockwise = (g: Grid): Grid => make(g.h, g.w, (x, y) => at(g, y, g.h - 1 - x))
const mirrorH = (g: Grid): Grid => make(g.w, g.h, (x, y) => at(g, g.w - 1 - x, y))
const mirrorV = (g: Grid): Grid => make(g.w, g.h, (x, y) => at(g, x, g.h - 1 - y))

// CIPA DC-008 §4.6.4 Table 4, read literally: where the stored 0th row and 0th column appear when displayed.
const PLACEMENT: Record<Orientation, { row: "top" | "bottom" | "left" | "right"; column: "top" | "bottom" | "left" | "right" }> = {
	1: { row: "top", column: "left" },
	2: { row: "top", column: "right" },
	3: { row: "bottom", column: "right" },
	4: { row: "bottom", column: "left" },
	5: { row: "left", column: "top" },
	6: { row: "right", column: "top" },
	7: { row: "right", column: "bottom" },
	8: { row: "left", column: "bottom" }
}

function display(stored: Grid, orientation: Orientation): Grid {
	const { row, column } = PLACEMENT[orientation]

	if (row === "top" || row === "bottom") {
		// Stored rows stay rows.
		return make(stored.w, stored.h, (x, y) =>
			at(stored, column === "left" ? x : stored.w - 1 - x, row === "top" ? y : stored.h - 1 - y)
		)
	}

	// Stored rows become columns: display x walks stored rows, display y walks stored columns.
	return make(stored.h, stored.w, (x, y) => at(stored, column === "top" ? y : stored.w - 1 - y, row === "left" ? x : stored.h - 1 - x))
}

const STORED = make(3, 2, (x, y) => y * 3 + x + 1)
const ORIENTATIONS: Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8]

describe("composeOrientation", () => {
	const ops: { name: string; turns: QuarterTurns; flipH: boolean; flipV: boolean; apply: (g: Grid) => Grid }[] = [
		{ name: "rotR", turns: 1, flipH: false, flipV: false, apply: rotateClockwise },
		{ name: "rotL", turns: 3, flipH: false, flipV: false, apply: g => rotateClockwise(rotateClockwise(rotateClockwise(g))) },
		{ name: "flipH", turns: 0, flipH: true, flipV: false, apply: mirrorH },
		{ name: "flipV", turns: 0, flipH: false, flipV: true, apply: mirrorV }
	]

	for (const op of ops) {
		for (const stored of ORIENTATIONS) {
			it(`${op.name} after ${String(stored)} matches the pixels`, () => {
				const composed = composeOrientation(stored, op.turns, op.flipH, op.flipV)

				expect(display(STORED, composed)).toEqual(op.apply(display(STORED, stored)))
			})
		}
	}

	it("matches the review's table", () => {
		const table = {
			rotR: [6, 7, 8, 5, 2, 3, 4, 1],
			rotL: [8, 5, 6, 7, 4, 1, 2, 3],
			flipH: [2, 1, 4, 3, 6, 5, 8, 7],
			flipV: [4, 3, 2, 1, 8, 7, 6, 5]
		}

		for (const op of ops) {
			expect(ORIENTATIONS.map(o => composeOrientation(o, op.turns, op.flipH, op.flipV))).toEqual(table[op.name as keyof typeof table])
		}
	})

	it("turns, then flips in the turned frame", () => {
		for (const stored of ORIENTATIONS) {
			const composed = composeOrientation(stored, 1, true, true)

			expect(display(STORED, composed)).toEqual(mirrorV(mirrorH(rotateClockwise(display(STORED, stored)))))
		}
	})
})

// ── Geometry ─────────────────────────────────────────────────────────────────

function withGeometry(geometry: Partial<Geometry>): ImageEditRecipe {
	const recipe = identityRecipe()

	return { ...recipe, geometry: { ...recipe.geometry, ...geometry } }
}

const SOURCE = { width: 400, height: 300 }

function expectPoint(actual: [number, number], expected: [number, number]): void {
	expect(actual[0]).toBeCloseTo(expected[0], 6)
	expect(actual[1]).toBeCloseTo(expected[1], 6)
}

describe("identity and geometry-only", () => {
	it("a fresh recipe is the identity and geometry-only", () => {
		expect(isIdentity(identityRecipe())).toBe(true)
		expect(isGeometryOnly(identityRecipe())).toBe(true)
	})

	it("an aspect preset alone is no edit", () => {
		expect(isIdentity(withGeometry({ aspect: "square" }))).toBe(true)
	})

	it("turns and flips are geometry-only", () => {
		const recipe = withGeometry({ quarterTurns: 1, flipH: true })

		expect(isIdentity(recipe)).toBe(false)
		expect(isGeometryOnly(recipe)).toBe(true)
	})

	it("a crop, an angle, an adjustment, a filter or markup is not", () => {
		const base = identityRecipe()

		expect(isGeometryOnly(withGeometry({ crop: { x: 0.1, y: 0, width: 0.9, height: 1 } }))).toBe(false)
		expect(isGeometryOnly(withGeometry({ angle: 2 }))).toBe(false)
		expect(isGeometryOnly({ ...base, adjustments: { ...base.adjustments, contrast: 5 } })).toBe(false)
		expect(isGeometryOnly({ ...base, filter: "mono" })).toBe(false)
		expect(isGeometryOnly({ ...base, markup: [{ kind: "text", id: "t", color: "#fff", size: 10, at: [0, 0], text: "x" }] })).toBe(false)
	})

	it("a crop within float noise of the frame counts as full", () => {
		expect(isGeometryOnly(withGeometry({ crop: { x: 1e-9, y: 0, width: 1 - 1e-9, height: 1 } }))).toBe(true)
	})
})

describe("outputSize", () => {
	it("swaps on odd turns and scales by the crop", () => {
		expect(outputSize(withGeometry({ quarterTurns: 1 }), SOURCE)).toEqual({ width: 300, height: 400 })
		expect(outputSize(withGeometry({ crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 } }), SOURCE)).toEqual({ width: 200, height: 150 })
	})

	it("is never 0", () => {
		expect(outputSize(withGeometry({ crop: { x: 0, y: 0, width: 0.0001, height: 0.0001 } }), SOURCE)).toEqual({ width: 1, height: 1 })
	})
})

describe("straightenScale", () => {
	it("is 1 at 0° and grows with the angle", () => {
		expect(straightenScale(0, 400, 300)).toBe(1)
		expect(straightenScale(10, 400, 300)).toBeGreaterThan(1)
		expect(straightenScale(-10, 400, 300)).toBeCloseTo(straightenScale(10, 400, 300), 12)
	})

	it("matches the bounding-box formula", () => {
		const r = (30 * Math.PI) / 180
		const c = Math.cos(r)
		const s = Math.sin(r)

		expect(straightenScale(30, 400, 300)).toBeCloseTo(Math.max((400 * c + 300 * s) / 400, (400 * s + 300 * c) / 300), 12)
	})

	it("a square at 45° grows by √2", () => {
		expect(straightenScale(45, 100, 100)).toBeCloseTo(Math.SQRT2, 12)
	})
})

describe("clampCrop", () => {
	const frame = { width: 400, height: 300 }

	it("keeps a crop inside the frame and at least the minimum size", () => {
		expect(clampCrop({ x: -0.2, y: 0.9, width: 0.5, height: 0.5 }, 0, frame)).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 })
		expect(clampCrop({ x: 0, y: 0, width: 0, height: 2 }, 0, frame)).toEqual({ x: 0, y: 0, width: 0.02, height: 1 })
	})

	it("shrinks a full crop by 1 / straightenScale when straightened", () => {
		const crop = clampCrop({ x: 0, y: 0, width: 1, height: 1 }, 10, frame)

		expect(crop.width).toBeCloseTo(1 / straightenScale(10, 400, 300), 9)
		expect(crop.height).toBeCloseTo(1 / straightenScale(10, 400, 300), 9)
		expect(crop.x + crop.width / 2).toBeCloseTo(0.5, 12)
		expect(crop.y + crop.height / 2).toBeCloseTo(0.5, 12)
	})

	it("keeps every corner, turned back, inside the frame", () => {
		const angle = -17
		const crop = clampCrop({ x: 0.05, y: 0.1, width: 0.6, height: 0.7 }, angle, frame)
		const recipe = withGeometry({ angle, crop })
		const m = geometryMatrix(recipe, SOURCE)
		const out = outputSize(recipe, SOURCE)

		for (const [x, y] of [
			[0, 0],
			[out.width, 0],
			[0, out.height],
			[out.width, out.height]
		] as const) {
			const [sx, sy] = transformPoint(m, x, y)

			expect(sx).toBeGreaterThanOrEqual(-1e-6)
			expect(sy).toBeGreaterThanOrEqual(-1e-6)
			expect(sx).toBeLessThanOrEqual(400 + 1e-6)
			expect(sy).toBeLessThanOrEqual(300 + 1e-6)
		}
	})
})

describe("aspectRect", () => {
	const frame = { width: 400, height: 300 }

	it("fits the largest centred rect of the ratio", () => {
		const square = aspectRect("square", frame)

		expect(square.width * 400).toBeCloseTo(300, 9)
		expect(square.height).toBeCloseTo(1, 12)
		expect(square.x).toBeCloseTo(0.125, 12)

		const wide = aspectRect("16:9", frame)

		expect((wide.width * 400) / (wide.height * 300)).toBeCloseTo(16 / 9, 9)
		expect(wide.width).toBeCloseTo(1, 12)
	})

	it("original is the turned frame's own; free keeps the crop", () => {
		expect(aspectRect("original", turnedSize(1, frame))).toEqual({ x: 0, y: 0, width: 1, height: 1 })

		const within = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

		expect(aspectRect("free", frame, within)).toEqual(within)
	})
})

describe("geometryMatrix", () => {
	it("is the identity for the identity recipe", () => {
		const m = geometryMatrix(identityRecipe(), SOURCE)

		expectPoint(transformPoint(m, 0, 0), [0, 0])
		expectPoint(transformPoint(m, 400, 300), [400, 300])
	})

	it("maps a clockwise turn's output corners back to the source", () => {
		// After a clockwise turn the output's top-left shows the source's bottom-left.
		const m = geometryMatrix(withGeometry({ quarterTurns: 1 }), SOURCE)

		expectPoint(transformPoint(m, 0, 0), [0, 300])
		expectPoint(transformPoint(m, 300, 0), [0, 0])
		expectPoint(transformPoint(m, 300, 400), [400, 0])
	})

	it("agrees with the pixel reference for every turn and flip", () => {
		const source = make(3, 2, (x, y) => y * 3 + x + 1)

		for (const turns of [0, 1, 2, 3] as QuarterTurns[]) {
			for (const flipH of [false, true]) {
				for (const flipV of [false, true]) {
					let expected = source

					for (let i = 0; i < turns; i++) {
						expected = rotateClockwise(expected)
					}

					if (flipH) {
						expected = mirrorH(expected)
					}

					if (flipV) {
						expected = mirrorV(expected)
					}

					const recipe = withGeometry({ quarterTurns: turns, flipH, flipV })
					const m = geometryMatrix(recipe, { width: 3, height: 2 })
					// Sample each output pixel at its centre.
					const actual = make(expected.w, expected.h, (x, y) => {
						const [sx, sy] = transformPoint(m, x + 0.5, y + 0.5)

						return at(source, Math.floor(sx), Math.floor(sy))
					})

					expect(actual).toEqual(expected)
				}
			}
		}
	})

	it("crops in the turned frame", () => {
		const recipe = withGeometry({ quarterTurns: 2, crop: { x: 0.5, y: 0, width: 0.5, height: 0.5 } })
		const m = geometryMatrix(recipe, SOURCE)

		// Turned 180°, the turned frame's top-right quarter is the source's bottom-left quarter.
		expectPoint(transformPoint(m, 0, 0), [200, 300])
		expectPoint(transformPoint(m, 200, 150), [0, 150])
	})

	it("straightens about the crop centre, a positive angle turning the picture clockwise", () => {
		const crop = clampCrop({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 10, SOURCE)
		const recipe = withGeometry({ angle: 10, crop })
		const out = outputSize(recipe, SOURCE)
		const m = geometryMatrix(recipe, SOURCE)

		expectPoint(transformPoint(m, out.width / 2, out.height / 2), [200, 150])

		// A point to the right of the centre in the output came from above-right in the source: the source was
		// turned clockwise to land there.
		const [, sy] = transformPoint(m, out.width / 2 + 50, out.height / 2)

		expect(sy).toBeLessThan(150)
	})

	it("inverts to place markup", () => {
		const recipe = withGeometry({
			quarterTurns: 3,
			flipH: true,
			angle: -7,
			crop: clampCrop({ x: 0.1, y: 0.1, width: 0.7, height: 0.6 }, -7, turnedSize(3, SOURCE))
		})
		const m = geometryMatrix(recipe, SOURCE)
		const [sx, sy] = transformPoint(m, 37, 91)

		expectPoint(mapMarkupPoint(recipe, SOURCE, sx, sy), [37, 91])
		expectPoint(transformPoint(invertMatrix3(m), sx, sy), [37, 91])
	})
})

describe("sourceRectForTile", () => {
	it("is the tile itself, padded and clamped, for the identity", () => {
		expect(sourceRectForTile(identityRecipe(), SOURCE, { x: 100, y: 50, width: 100, height: 100 }, 4)).toEqual({
			x: 96,
			y: 46,
			width: 108,
			height: 108
		})
		expect(sourceRectForTile(identityRecipe(), SOURCE, { x: 0, y: 0, width: 50, height: 50 }, 4)).toEqual({
			x: 0,
			y: 0,
			width: 54,
			height: 54
		})
	})

	it("follows a turn", () => {
		// Output tile at the top-left of a clockwise-turned image samples the source's bottom-left.
		expect(sourceRectForTile(withGeometry({ quarterTurns: 1 }), SOURCE, { x: 0, y: 0, width: 100, height: 50 }, 0)).toEqual({
			x: 0,
			y: 200,
			width: 50,
			height: 100
		})
	})

	it("covers a straightened tile's whole bounding box", () => {
		const crop = clampCrop({ x: 0, y: 0, width: 1, height: 1 }, 20, SOURCE)
		const recipe = withGeometry({ angle: 20, crop })
		const tile = { x: 10, y: 10, width: 64, height: 64 }
		const rect = sourceRectForTile(recipe, SOURCE, tile, 2)
		const m = geometryMatrix(recipe, SOURCE)

		for (const [x, y] of [
			[10, 10],
			[74, 10],
			[10, 74],
			[74, 74]
		] as const) {
			const [sx, sy] = transformPoint(m, x, y)

			expect(sx).toBeGreaterThanOrEqual(rect.x)
			expect(sy).toBeGreaterThanOrEqual(rect.y)
			expect(sx).toBeLessThanOrEqual(rect.x + rect.width)
			expect(sy).toBeLessThanOrEqual(rect.y + rect.height)
		}
	})
})
