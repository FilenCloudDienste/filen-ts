import { describe, expect, it } from "vitest"
import {
	EMBED_MEDIA_MAX_HEIGHT,
	EMBED_MEDIA_MAX_WIDTH,
	EMBED_MEDIA_MIN_EDGE,
	EMBED_MEDIA_PLACEHOLDER,
	embedMediaFrame,
	rememberedEmbedMediaSize,
	rememberEmbedMediaSize
} from "@/features/chats/lib/embeds.logic"

function aspect(size: { width: number; height: number }): number {
	return size.width / size.height
}

describe("embedMediaFrame", () => {
	it("reserves the placeholder while the size is unknown or degenerate", () => {
		expect(embedMediaFrame(null)).toEqual(EMBED_MEDIA_PLACEHOLDER)
		expect(embedMediaFrame({ width: 0, height: 0 })).toEqual(EMBED_MEDIA_PLACEHOLDER)
		expect(embedMediaFrame({ width: 100, height: Number.NaN })).toEqual(EMBED_MEDIA_PLACEHOLDER)
		expect(embedMediaFrame({ width: Number.POSITIVE_INFINITY, height: 10 })).toEqual(EMBED_MEDIA_PLACEHOLDER)
	})

	it("fits a portrait image by height, keeping its aspect", () => {
		const frame = embedMediaFrame({ width: 3000, height: 4000 })

		expect(frame.height).toBe(EMBED_MEDIA_MAX_HEIGHT)
		expect(frame.width).toBe(216)
		expect(aspect(frame)).toBeCloseTo(0.75, 2)
	})

	it("fits a landscape image by width, keeping its aspect", () => {
		const frame = embedMediaFrame({ width: 4000, height: 2250 })

		expect(frame.width).toBe(EMBED_MEDIA_MAX_WIDTH)
		expect(frame.height).toBe(216)
	})

	it("never upscales a small image", () => {
		expect(embedMediaFrame({ width: 120, height: 90 })).toEqual({ width: 120, height: 90 })
	})

	it("clamps a tiny image to the minimum edge", () => {
		expect(embedMediaFrame({ width: 8, height: 8 })).toEqual({ width: EMBED_MEDIA_MIN_EDGE, height: EMBED_MEDIA_MIN_EDGE })
	})

	it("keeps an extreme-aspect file within bounds on both edges", () => {
		expect(embedMediaFrame({ width: 10000, height: 10 })).toEqual({ width: EMBED_MEDIA_MAX_WIDTH, height: EMBED_MEDIA_MIN_EDGE })
		expect(embedMediaFrame({ width: 10, height: 10000 })).toEqual({ width: EMBED_MEDIA_MIN_EDGE, height: EMBED_MEDIA_MAX_HEIGHT })
	})

	it("stays within bounds and on whole pixels for any size", () => {
		for (const width of [1, 47, 48, 383, 384, 385, 1920, 8000]) {
			for (const height of [1, 47, 48, 287, 288, 289, 1080, 8000]) {
				const frame = embedMediaFrame({ width, height })

				expect(frame.width).toBeLessThanOrEqual(EMBED_MEDIA_MAX_WIDTH)
				expect(frame.height).toBeLessThanOrEqual(EMBED_MEDIA_MAX_HEIGHT)
				expect(frame.width).toBeGreaterThanOrEqual(EMBED_MEDIA_MIN_EDGE)
				expect(frame.height).toBeGreaterThanOrEqual(EMBED_MEDIA_MIN_EDGE)
				expect(Number.isInteger(frame.width) && Number.isInteger(frame.height)).toBe(true)
			}
		}
	})
})

describe("remembered embed media sizes", () => {
	it("returns a remembered size by uuid", () => {
		expect(rememberedEmbedMediaSize("frame-a")).toBeNull()

		rememberEmbedMediaSize("frame-a", { width: 640, height: 480 })

		expect(rememberedEmbedMediaSize("frame-a")).toEqual({ width: 640, height: 480 })
	})

	it("evicts the oldest entry past its bound", () => {
		rememberEmbedMediaSize("frame-oldest", { width: 1, height: 1 })

		for (let index = 0; index < 300; index++) {
			rememberEmbedMediaSize("frame-fill-" + String(index), { width: 2, height: 2 })
		}

		expect(rememberedEmbedMediaSize("frame-oldest")).toBeNull()
		expect(rememberedEmbedMediaSize("frame-fill-299")).toEqual({ width: 2, height: 2 })
	})
})
