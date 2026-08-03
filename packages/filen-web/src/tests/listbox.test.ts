import { describe, expect, it } from "vitest"
import { clampListboxIndex, listboxKeyTarget, listboxRange, resolveCursorIndex } from "@/features/drive/lib/listbox"

describe("clampListboxIndex", () => {
	it("passes through an index already in range", () => {
		expect(clampListboxIndex(3, 10)).toBe(3)
	})

	it("clamps a negative index up to 0", () => {
		expect(clampListboxIndex(-5, 10)).toBe(0)
	})

	it("clamps an index past the end down to length - 1", () => {
		expect(clampListboxIndex(99, 10)).toBe(9)
	})

	it("returns 0 for a zero-length list", () => {
		expect(clampListboxIndex(4, 0)).toBe(0)
	})

	it("returns 0 for a single-item list regardless of the requested index", () => {
		expect(clampListboxIndex(7, 1)).toBe(0)
		expect(clampListboxIndex(-7, 1)).toBe(0)
	})
})

describe("listboxRange", () => {
	it("returns a single-element range when anchor equals active", () => {
		expect(listboxRange(3, 3)).toEqual([3])
	})

	it("returns an ascending inclusive range when the anchor precedes the active index", () => {
		expect(listboxRange(2, 5)).toEqual([2, 3, 4, 5])
	})

	it("returns the same ascending range when the anchor follows the active index", () => {
		expect(listboxRange(5, 2)).toEqual([2, 3, 4, 5])
	})

	it("handles adjacent indices", () => {
		expect(listboxRange(4, 5)).toEqual([4, 5])
	})
})

describe("resolveCursorIndex", () => {
	// The bug this closes: a positional index alone drifts under a background reorder (sort-by-size
	// backfilling sizes, a live socket/optimistic patch) with no navigation. Tracking by uuid and
	// re-mapping to the current index keeps a held cursor on the SAME item across the reorder.
	it("re-maps to the tracked uuid's new position after a reorder", () => {
		const before = ["a", "b", "c"]
		const after = ["c", "a", "b"]

		const index = resolveCursorIndex("c", before, 2)
		expect(index).toBe(2)

		// Same uuid, reordered list — cursor follows the item, not the slot.
		expect(resolveCursorIndex("c", after, index)).toBe(0)
	})

	it("returns the fallback index (clamped) when the tracked uuid is not yet set", () => {
		expect(resolveCursorIndex(null, ["a", "b", "c"], 1)).toBe(1)
		expect(resolveCursorIndex(null, ["a", "b", "c"], 99)).toBe(2)
	})

	it("clamps to a neighbor when the tracked uuid has vanished from the list", () => {
		// "b" was at index 1 and is now gone (deleted/filtered/moved) — falls back to the last known
		// position, clamped into the new (shorter) bounds, instead of crashing or snapping to 0.
		expect(resolveCursorIndex("b", ["a", "c"], 1)).toBe(1)
	})

	it("clamps the fallback into an empty list without throwing", () => {
		expect(resolveCursorIndex("gone", [], 4)).toBe(0)
	})
})

describe("listboxKeyTarget", () => {
	it("moves one row down/up by `step` in a single-column list", () => {
		expect(listboxKeyTarget("ArrowDown", 3, 10, 1, false)).toBe(4)
		expect(listboxKeyTarget("ArrowUp", 3, 10, 1, false)).toBe(2)
	})

	it("moves a whole grid row down/up when `step` is the column count", () => {
		expect(listboxKeyTarget("ArrowDown", 1, 20, 4, true)).toBe(5)
		expect(listboxKeyTarget("ArrowUp", 9, 20, 4, true)).toBe(5)
	})

	it("honors Left/Right only when the horizontal axis is live", () => {
		expect(listboxKeyTarget("ArrowRight", 3, 10, 4, true)).toBe(4)
		expect(listboxKeyTarget("ArrowLeft", 3, 10, 4, true)).toBe(2)
	})

	it("ignores Left/Right in a single-column list, which has no horizontal axis", () => {
		expect(listboxKeyTarget("ArrowRight", 3, 10, 1, false)).toBeNull()
		expect(listboxKeyTarget("ArrowLeft", 3, 10, 1, false)).toBeNull()
	})

	it("Home targets the first item", () => {
		expect(listboxKeyTarget("Home", 7, 10, 4, true)).toBe(0)
	})

	it("End targets the last item", () => {
		expect(listboxKeyTarget("End", 0, 10, 4, true)).toBe(9)
	})

	it("returns null for a key this listbox does not move on", () => {
		expect(listboxKeyTarget("Enter", 3, 10, 4, true)).toBeNull()
		expect(listboxKeyTarget(" ", 3, 10, 4, true)).toBeNull()
		expect(listboxKeyTarget("PageDown", 3, 10, 4, true)).toBeNull()
	})

	it("returns out-of-range targets raw — clamping is the caller's job", () => {
		expect(listboxKeyTarget("ArrowDown", 9, 10, 4, true)).toBe(13)
		expect(listboxKeyTarget("ArrowUp", 0, 10, 4, true)).toBe(-4)
	})
})
