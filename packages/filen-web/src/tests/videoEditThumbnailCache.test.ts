import { describe, expect, it, vi } from "vitest"
import { ThumbnailCache } from "@/features/preview/videoEdit/components/thumbnailCache"
import { filmstripBudget } from "@/features/preview/videoEdit/lib/timeline.logic"

// The filmstrip's tile cache: bounded by the bytes its tiles hold (least recently used closed first), and closing
// what arrives after the timeline went.

function tile(width = 100, height = 50): ImageBitmap {
	return { width, height, close: vi.fn() }
}

describe("ThumbnailCache", () => {
	it("closes the least recently used tiles past its byte budget", () => {
		const cache = new ThumbnailCache(2 * 100 * 50 * 4)
		const a = tile()
		const b = tile()
		const c = tile()

		cache.set("a", a)
		cache.set("b", b)
		cache.get("a")
		cache.set("c", c)

		expect(cache.has("b")).toBe(false)
		expect(b.close).toHaveBeenCalledTimes(1)
		expect(cache.has("a")).toBe(true)
		expect(cache.size).toBe(2 * 100 * 50 * 4)
	})

	it("counts a tile's real size, so a few big tiles fill what many small ones would", () => {
		const cache = new ThumbnailCache(100 * 50 * 4)

		cache.set("small1", tile(50, 25))
		cache.set("small2", tile(50, 25))
		cache.set("small3", tile(50, 25))
		cache.set("small4", tile(50, 25))
		expect(cache.size).toBe(100 * 50 * 4)

		cache.set("big", tile(100, 50))
		expect(cache.size).toBe(100 * 50 * 4)
		expect(cache.has("small4")).toBe(false)
	})

	it("shrinks to a smaller budget at once", () => {
		const cache = new ThumbnailCache(10 * 100 * 50 * 4)

		for (let index = 0; index < 5; index++) {
			cache.set(String(index), tile())
		}

		cache.setBudget(2 * 100 * 50 * 4)
		expect(cache.size).toBe(2 * 100 * 50 * 4)
		expect(cache.has("4")).toBe(true)
		expect(cache.has("0")).toBe(false)
	})

	it("closes tiles that arrive after it was cleared, until opened again", () => {
		const cache = new ThumbnailCache(1_000_000)
		const kept = tile()
		const late = tile()

		cache.set("kept", kept)
		cache.clear()
		expect(kept.close).toHaveBeenCalledTimes(1)

		cache.set("late", late)
		expect(late.close).toHaveBeenCalledTimes(1)
		expect(cache.has("late")).toBe(false)

		cache.open()
		cache.set("again", tile())
		expect(cache.has("again")).toBe(true)
	})
})

describe("filmstripBudget", () => {
	it("holds a few screens of the visible tiles", () => {
		// 920 px of 92 px tiles: 10 slots and a partly shown one, 92×52 CSS px at 2× each.
		expect(filmstripBudget(920, 92, 52, 2, 3)).toBe(11 * 184 * 104 * 4 * 3)
		expect(filmstripBudget(920, 92, 52, 2, 1.5)).toBeLessThan(filmstripBudget(920, 92, 52, 2, 3))
		expect(filmstripBudget(0, 92, 52, 1, 3)).toBe(92 * 52 * 4 * 3)
	})
})
