import { describe, expect, it } from "vitest"
import { geometryMatrix, identityRecipe, sourceRectForTile, transformPoint, type Matrix3 } from "@/features/preview/imageEdit/lib/recipe"
import type { ImageEditRecipe } from "@/features/preview/imageEdit/types"
import {
	affine,
	composeMatrix3,
	containTransform,
	coverTransform,
	expandRect,
	exportTileEdge,
	matrixRows,
	matrixScale,
	planTiles,
	previewMargin,
	previewSize,
	previewUploadTiles,
	scaleTranslate,
	sharpenPad,
	sharpenRadius,
	type Rect
} from "@/features/preview/imageEdit/worker/tiles"

function covers(tiles: readonly Rect[], width: number, height: number): void {
	const hits = new Uint8Array(width * height)

	for (const tile of tiles) {
		for (let y = tile.y; y < tile.y + tile.height; y++) {
			for (let x = tile.x; x < tile.x + tile.width; x++) {
				hits[y * width + x] = (hits[y * width + x] ?? 0) + 1
			}
		}
	}

	expect(hits.every(count => count === 1)).toBe(true)
}

function straightened(angle: number, turns: 0 | 1 | 2 | 3): ImageEditRecipe {
	const recipe = identityRecipe()

	return { ...recipe, geometry: { ...recipe.geometry, angle, quarterTurns: turns, crop: { x: 0.1, y: 0.15, width: 0.7, height: 0.6 } } }
}

describe("matrix helpers", () => {
	it("composes outer after inner", () => {
		const inner = affine(0.8, 0.6, -0.6, 0.8, 10, -4)
		const outer = scaleTranslate(2, -1, 3, 50)
		const composed = composeMatrix3(outer, inner)
		const [ix, iy] = transformPoint(inner, 7, 11)

		expect(transformPoint(composed, 7, 11)[0]).toBeCloseTo(transformPoint(outer, ix, iy)[0], 10)
		expect(transformPoint(composed, 7, 11)[1]).toBeCloseTo(transformPoint(outer, ix, iy)[1], 10)
	})

	it("reports a similarity's scale and its GLSL rows", () => {
		const m: Matrix3 = affine(0, 3, -3, 0, 5, 6)

		expect(matrixScale(m)).toBeCloseTo(3, 10)
		expect(matrixRows(m)).toEqual({ x: [0, -3, 5], y: [3, 0, 6] })
	})
})

describe("planTiles", () => {
	it("partitions the output exactly", () => {
		covers(planTiles(37, 23, 10), 37, 23)
		covers(planTiles(10, 10, 10), 10, 10)
		covers(planTiles(5, 3, 64), 5, 3)
	})

	it("orders tiles row-major from the top left", () => {
		expect(planTiles(20, 20, 10).map(tile => [tile.x, tile.y])).toEqual([
			[0, 0],
			[10, 0],
			[0, 10],
			[10, 10]
		])
	})
})

describe("exportTileEdge", () => {
	it("keeps the padded tile and its source rectangle within the texture limit", () => {
		const source = { width: 9000, height: 6000 }
		const limit = 4096

		for (const turns of [0, 1, 2, 3] as const) {
			for (const angle of [0, 7.5, -30, 45]) {
				const recipe = straightened(angle, turns)
				const m = geometryMatrix(recipe, source)
				const pad = sharpenPad(3.2)
				const edge = exportTileEdge(limit, pad, 2, m)

				expect(edge + 2 * pad).toBeLessThanOrEqual(limit)

				const rect = sourceRectForTile(recipe, source, expandRect({ x: 100, y: 100, width: edge, height: edge }, pad), 2)

				expect(rect.width).toBeLessThanOrEqual(limit)
				expect(rect.height).toBeLessThanOrEqual(limit)
			}
		}
	})

	it("uses the whole limit for an unrotated 1:1 mapping", () => {
		expect(exportTileEdge(4096, 0, 2, affine(1, 0, 0, 1, 0, 0))).toBe(4090)
	})
})

describe("preview build", () => {
	it("scales the long side down to the cap, never up", () => {
		expect(previewSize(8000, 6000, 3072)).toEqual({ width: 3072, height: 2304, scale: 0.384 })
		expect(previewSize(800, 600, 3072)).toEqual({ width: 800, height: 600, scale: 1 })
	})

	it("splits the source into uploads within one texture whose inner parts partition it", () => {
		const margin = previewMargin(0.25)
		const tiles = previewUploadTiles(10000, 7000, 4096, margin)

		covers(
			tiles.map(tile => tile.inner),
			10000,
			7000
		)

		for (const { upload, inner } of tiles) {
			expect(upload.width).toBeLessThanOrEqual(4096)
			expect(upload.height).toBeLessThanOrEqual(4096)
			expect(upload.x).toBe(Math.max(0, inner.x - margin))
			expect(upload.y).toBe(Math.max(0, inner.y - margin))
			expect(upload.x + upload.width).toBe(Math.min(10000, inner.x + inner.width + margin))
		}
	})

	it("widens the margin as the shrink grows", () => {
		expect(previewMargin(1)).toBe(4)
		expect(previewMargin(0.25)).toBe(10)
	})
})

describe("viewport fits", () => {
	it("contains the output centred", () => {
		const m = containTransform({ width: 400, height: 200 }, { width: 1000, height: 1000 })

		expect(transformPoint(m, 0, 0)).toEqual([0, 250])
		expect(transformPoint(m, 400, 200)).toEqual([1000, 750])
	})

	it("covers a square thumbnail centred", () => {
		const m = coverTransform({ width: 400, height: 200 }, 96)

		expect(transformPoint(m, 200, 100)).toEqual([48, 48])
		expect(transformPoint(m, 0, 0)[1]).toBe(0)
		expect(transformPoint(m, 400, 200)[1]).toBe(96)
		expect(transformPoint(m, 0, 0)[0]).toBeLessThan(0)
	})
})

describe("sharpen reach", () => {
	it("scales the radius with the output and pads past it", () => {
		expect(sharpenRadius(1000, 800)).toBe(1)
		expect(sharpenRadius(8000, 6000)).toBe(4)
		expect(sharpenPad(4)).toBe(5)
		expect(sharpenPad(1.2)).toBe(3)
	})
})
