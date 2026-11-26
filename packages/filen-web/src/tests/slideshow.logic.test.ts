import { describe, expect, it } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	DEFAULT_SLIDESHOW_INTERVAL,
	SHOW_TIMEOUT_MS,
	SLIDESHOW_INTERVALS,
	nextSlide,
	slideDue,
	slideKindOf,
	slideshowOrder,
	type SlideKind
} from "@/features/preview/lib/slideshow.logic"
import { testUuid } from "@/tests/support/uuid"

function fileNamed(name: string): DriveItem {
	const file: File = {
		uuid: testUuid("file"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1n, key: "k", version: 2 }
		}
	}

	return narrowItem(file)
}

// A deterministic generator in [0, 1).
function seeded(seed: number): () => number {
	let state = seed

	return () => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296

		return state / 4_294_967_296
	}
}

const KINDS: (SlideKind | null)[] = ["image", null, "video", "image", null, "image"]

describe("slideshowOrder", () => {
	it("skips unslideable items and starts at the opened one", () => {
		expect(slideshowOrder(KINDS, 3, false)).toEqual({ order: [0, 2, 3, 5], position: 2 })
		expect(slideshowOrder(KINDS, 0, false)).toEqual({ order: [0, 2, 3, 5], position: 0 })
	})

	it("starts at the next slideable item when the opened one is not slideable", () => {
		expect(slideshowOrder(KINDS, 1, false)).toEqual({ order: [0, 2, 3, 5], position: 1 })
		expect(slideshowOrder(KINDS, 4, false)).toEqual({ order: [0, 2, 3, 5], position: 3 })
	})

	it("is empty when nothing is slideable", () => {
		expect(slideshowOrder([null, null], 0, false)).toEqual({ order: [], position: 0 })
	})

	it("shuffle keeps the start first and is a permutation", () => {
		const result = slideshowOrder(KINDS, 3, true, seeded(7))

		expect(result.position).toBe(0)
		expect(result.order[0]).toBe(3)
		expect([...result.order].sort((a, b) => a - b)).toEqual([0, 2, 3, 5])
	})
})

describe("nextSlide", () => {
	it("wraps both ways", () => {
		const order = { order: [0, 2, 3], position: 2 }

		expect(nextSlide(order, 1, false)).toEqual({ order: [0, 2, 3], position: 0 })
		expect(nextSlide({ order: [0, 2, 3], position: 0 }, -1, false)).toEqual({ order: [0, 2, 3], position: 2 })
		expect(nextSlide({ order: [0, 2, 3], position: 0 }, 1, false)).toEqual({ order: [0, 2, 3], position: 1 })
	})

	it("a shuffled forward wrap reshuffles and never repeats the last slide first", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const order = { order: [4, 1, 3, 0, 2], position: 4 }
			const next = nextSlide(order, 1, true, seeded(seed))

			expect(next.position).toBe(0)
			expect(next.order[0]).not.toBe(2)
			expect([...next.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
		}
	})

	it("a shuffled backward wrap keeps the order", () => {
		expect(nextSlide({ order: [4, 1, 3], position: 0 }, -1, true, seeded(3))).toEqual({ order: [4, 1, 3], position: 2 })
	})

	it("a shuffled step inside the lap keeps the order", () => {
		expect(nextSlide({ order: [4, 1, 3], position: 0 }, 1, true, seeded(3))).toEqual({ order: [4, 1, 3], position: 1 })
	})

	it("handles an empty order", () => {
		expect(nextSlide({ order: [], position: 0 }, 1, true)).toEqual({ order: [], position: 0 })
	})
})

describe("slideKindOf", () => {
	it("maps images, RAW and playable videos", () => {
		expect(slideKindOf(fileNamed("beach.jpg"))).toBe("image")
		expect(slideKindOf(fileNamed("DSC0001.NEF"))).toBe("image")
		expect(slideKindOf(fileNamed("clip.mp4"))).toBe("video")
	})

	it("drops wmv and audio", () => {
		expect(slideKindOf(fileNamed("clip.wmv"))).toBeNull()
		expect(slideKindOf(fileNamed("song.mp3"))).toBeNull()
		expect(slideKindOf(fileNamed("notes.pdf"))).toBeNull()
	})
})

describe("slideDue", () => {
	const base = { animating: false, shownAt: 1_000, mountedAt: 0, mediaEnded: false, intervalMs: 5_000, now: 0 }

	it("image: after the interval from shownAt, not from mount", () => {
		expect(slideDue({ ...base, kind: "image", now: 5_999 })).toBe(false)
		expect(slideDue({ ...base, kind: "image", now: 6_000 })).toBe(true)
	})

	it("an animating image waits for both its loop and the interval", () => {
		expect(slideDue({ ...base, kind: "image", animating: true, now: 9_000 })).toBe(false)
		expect(slideDue({ ...base, kind: "image", animating: true, mediaEnded: true, now: 5_999 })).toBe(false)
		expect(slideDue({ ...base, kind: "image", animating: true, mediaEnded: true, now: 6_000 })).toBe(true)
	})

	it("video waits for its end only", () => {
		expect(slideDue({ ...base, kind: "video", now: 100_000 })).toBe(false)
		expect(slideDue({ ...base, kind: "video", mediaEnded: true, now: 1_001 })).toBe(true)
	})

	it("a still png (never animating) is due after the interval", () => {
		expect(slideDue({ ...base, kind: "image", animating: false, mediaEnded: false, now: 6_000 })).toBe(true)
	})

	it("an unshown slide is due after SHOW_TIMEOUT_MS", () => {
		const unshown = { ...base, shownAt: null }

		expect(slideDue({ ...unshown, kind: "image", now: SHOW_TIMEOUT_MS - 1 })).toBe(false)
		expect(slideDue({ ...unshown, kind: "image", now: SHOW_TIMEOUT_MS })).toBe(true)
		expect(slideDue({ ...unshown, kind: "video", now: SHOW_TIMEOUT_MS })).toBe(true)
	})

	it("a video that ended before it showed (it failed before playing) is due at once", () => {
		const unshown = { ...base, shownAt: null }

		expect(slideDue({ ...unshown, kind: "video", mediaEnded: true, now: 1 })).toBe(true)
		expect(slideDue({ ...unshown, kind: "image", mediaEnded: true, now: 1 })).toBe(false)
	})
})

describe("constants", () => {
	it("offers the presets with the default among them", () => {
		expect(SLIDESHOW_INTERVALS).toEqual([3, 5, 10, 20])
		expect(SLIDESHOW_INTERVALS).toContain(DEFAULT_SLIDESHOW_INTERVAL)
	})
})
