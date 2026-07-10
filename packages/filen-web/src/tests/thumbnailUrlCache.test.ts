import { describe, expect, it, vi } from "vitest"
import { createThumbnailUrlCache, computeThumbnailCapacity } from "@/features/drive/lib/thumbnailUrlCache"
import { ROW_HEIGHT, TILE_WIDTH, TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"

describe("computeThumbnailCapacity — list vs grid math", () => {
	it("list mode scales purely with viewport height, ignoring width", () => {
		const short = computeThumbnailCapacity(1_000, ROW_HEIGHT * 4, "list")
		const tall = computeThumbnailCapacity(1_000, ROW_HEIGHT * 40, "list")

		expect(tall).toBeGreaterThan(short)
		expect(computeThumbnailCapacity(200, ROW_HEIGHT * 40, "list")).toBe(computeThumbnailCapacity(2_000, ROW_HEIGHT * 40, "list"))
	})

	it("grid mode scales with both width (columns) and height (rows)", () => {
		const oneColumn = computeThumbnailCapacity(TILE_WIDTH, TILE_ROW_HEIGHT * 10, "grid")
		const fourColumns = computeThumbnailCapacity(TILE_WIDTH * 4, TILE_ROW_HEIGHT * 10, "grid")

		expect(fourColumns).toBeGreaterThan(oneColumn)
	})

	it("a large viewport in grid mode needs a materially larger capacity than the same viewport in list mode", () => {
		// A wide, tall viewport packs many tile CELLS (columns * rows) but only as many list ROWS as fit
		// vertically — grid's capacity should come out higher for identical dimensions.
		const width = TILE_WIDTH * 6
		const height = TILE_ROW_HEIGHT * 6

		expect(computeThumbnailCapacity(width, height, "grid")).toBeGreaterThan(computeThumbnailCapacity(width, height, "list"))
	})

	it("floors at a minimum capacity for a zero/tiny viewport (module load, before the first layout frame)", () => {
		expect(computeThumbnailCapacity(0, 0, "list")).toBeGreaterThan(0)
		expect(computeThumbnailCapacity(0, 0, "grid")).toBeGreaterThan(0)
	})
})

describe("createThumbnailUrlCache — touch-refresh ordering", () => {
	it("get() moves a key to most-recently-used, sparing it from an eviction that would otherwise hit it", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(2, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")

		// Without the touch, "a" is the oldest and would be evicted next. Touching it first flips the
		// eviction order.
		cache.get("a")
		cache.set("c", "blob:c")

		expect(onEvict).toHaveBeenCalledExactlyOnceWith("b", "blob:b")
		expect(cache.get("a")).toBe("blob:a")
		expect(cache.get("c")).toBe("blob:c")
	})

	it("re-set()ing an existing key also refreshes its recency", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(2, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")
		cache.set("a", "blob:a2") // touch via overwrite, not just get()
		cache.set("c", "blob:c")

		expect(onEvict).toHaveBeenCalledExactlyOnceWith("b", "blob:b")
		expect(cache.get("a")).toBe("blob:a2")
	})
})

describe("createThumbnailUrlCache — revoke-on-evict", () => {
	it("calls onEvict with the exact (uuid, url) pair once capacity is exceeded, and never for entries still inside it", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(1, onEvict)

		cache.set("a", "blob:a")
		expect(onEvict).not.toHaveBeenCalled()

		cache.set("b", "blob:b")
		expect(onEvict).toHaveBeenCalledExactlyOnceWith("a", "blob:a")
		expect(cache.size()).toBe(1)
	})

	it("inserting several keys past capacity in one go evicts oldest-first, one onEvict call per entry", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(1, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")
		cache.set("c", "blob:c")

		expect(onEvict).toHaveBeenNthCalledWith(1, "a", "blob:a")
		expect(onEvict).toHaveBeenNthCalledWith(2, "b", "blob:b")
		expect(cache.size()).toBe(1)
	})
})

describe("createThumbnailUrlCache — resize recompute (setCapacity)", () => {
	it("growing capacity never evicts anything", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(5, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")
		cache.setCapacity(50)

		expect(onEvict).not.toHaveBeenCalled()
		expect(cache.size()).toBe(2)
	})

	it("shrinking capacity below the live count evicts the least-recently-used entries down to the new size", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(10, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")
		cache.set("c", "blob:c")
		cache.setCapacity(1)

		expect(onEvict).toHaveBeenNthCalledWith(1, "a", "blob:a")
		expect(onEvict).toHaveBeenNthCalledWith(2, "b", "blob:b")
		expect(cache.size()).toBe(1)
		expect(cache.get("c")).toBe("blob:c")
	})

	it("a shrink that touched a key first (simulating this render's live urls) spares that key", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(10, onEvict)

		cache.set("a", "blob:a")
		cache.set("b", "blob:b")
		cache.get("a") // "a" is now more recent than "b"
		cache.setCapacity(1)

		expect(onEvict).toHaveBeenCalledExactlyOnceWith("b", "blob:b")
		expect(cache.get("a")).toBe("blob:a")
	})
})

describe("createThumbnailUrlCache — invalidate-style delete interplay", () => {
	it("delete() frees a capacity slot immediately, so a subsequent set() at full capacity evicts no one", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(1, onEvict)

		cache.set("a", "blob:a")
		cache.delete("a")
		cache.set("b", "blob:b")

		expect(onEvict).not.toHaveBeenCalled()
		expect(cache.get("b")).toBe("blob:b")
	})

	it("delete() returns the removed url (so a caller can revoke it explicitly) and never calls onEvict itself", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(5, onEvict)

		cache.set("a", "blob:a")

		expect(cache.delete("a")).toBe("blob:a")
		expect(onEvict).not.toHaveBeenCalled()
	})

	it("delete() of a missing key is a clean no-op", () => {
		const onEvict = vi.fn()
		const cache = createThumbnailUrlCache(5, onEvict)

		expect(cache.delete("never-set")).toBeUndefined()
		expect(onEvict).not.toHaveBeenCalled()
	})
})
