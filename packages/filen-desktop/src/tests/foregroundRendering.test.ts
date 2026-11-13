import { describe, expect, it } from "vitest"
import { createForegroundRendering, type ThrottlingContents } from "../main/foregroundRendering.ts"

function fakeContents(id: number, throttling = true): ThrottlingContents & { throttling: boolean; destroyed: boolean; sets: boolean[] } {
	const contents = {
		id,
		throttling,
		destroyed: false,
		sets: [] as boolean[],
		isDestroyed: () => contents.destroyed,
		getBackgroundThrottling: () => contents.throttling,
		setBackgroundThrottling: (allowed: boolean) => {
			contents.sets.push(allowed)
			contents.throttling = allowed
		}
	}

	return contents
}

describe("foreground rendering", () => {
	it("turns throttling off while held and back on once every hold is released", () => {
		const rendering = createForegroundRendering()
		const contents = fakeContents(1)

		rendering.setHolds(contents, 1)
		rendering.setHolds(contents, 2)
		rendering.setHolds(contents, 1)

		expect(contents.throttling).toBe(false)

		rendering.setHolds(contents, 0)

		expect(contents.throttling).toBe(true)
		expect(contents.sets).toEqual([false, true])
	})

	it("restores the setting the window was created with", () => {
		const rendering = createForegroundRendering()
		const contents = fakeContents(1, false)

		rendering.setHolds(contents, 1)
		rendering.setHolds(contents, 0)

		expect(contents.throttling).toBe(false)
	})

	it("does nothing for a count of 0 without holds", () => {
		const rendering = createForegroundRendering()
		const contents = fakeContents(1)

		rendering.setHolds(contents, 0)
		rendering.pageGone(1)

		expect(contents.sets).toEqual([])
	})

	it("drops a page's holds when it goes, so a reload cannot leave throttling off", () => {
		const rendering = createForegroundRendering()
		const contents = fakeContents(1)

		rendering.setHolds(contents, 2)
		rendering.pageGone(1)

		expect(contents.throttling).toBe(true)

		rendering.setHolds(contents, 1)

		expect(contents.throttling).toBe(false)
	})

	it("keeps windows apart", () => {
		const rendering = createForegroundRendering()
		const first = fakeContents(1)
		const second = fakeContents(2)

		rendering.setHolds(first, 1)
		rendering.setHolds(second, 1)
		rendering.pageGone(1)

		expect(first.throttling).toBe(true)
		expect(second.throttling).toBe(false)
	})

	it("never touches destroyed contents", () => {
		const rendering = createForegroundRendering()
		const contents = fakeContents(1)

		rendering.setHolds(contents, 1)
		contents.destroyed = true
		rendering.pageGone(1)

		const late = fakeContents(2)

		late.destroyed = true
		rendering.setHolds(late, 1)

		expect(contents.sets).toEqual([false])
		expect(late.sets).toEqual([])
	})
})
