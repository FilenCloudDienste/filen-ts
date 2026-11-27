import { describe, expect, it } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { computeNext, insertIntoQueue, type QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: uuid, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

function uuids(queue: readonly QueueTrack[]): string[] {
	return queue.map(entry => entry.uuid)
}

const queue = ["a", "b", "c", "d"].map(track)

describe("insertIntoQueue without shuffle", () => {
	it("places Play next right after the current track", () => {
		const result = insertIntoQueue(queue, 1, false, [], [track("x"), track("y")], "next")

		expect(uuids(result.queue)).toEqual(["a", "b", "x", "y", "c", "d"])
		expect(result.currentIndex).toBe(1)
		expect(result.added).toBe(2)
		expect(result.shifted).toBe(true)
	})

	it("appends Add to queue without shifting anything", () => {
		const result = insertIntoQueue(queue, 1, false, [], [track("x")], "end")

		expect(uuids(result.queue)).toEqual(["a", "b", "c", "d", "x"])
		expect(result.currentIndex).toBe(1)
		expect(result.shifted).toBe(false)
	})

	it("makes Play next at the last track an append", () => {
		const result = insertIntoQueue(queue, 3, false, [], [track("x")], "next")

		expect(uuids(result.queue)).toEqual(["a", "b", "c", "d", "x"])
		expect(result.shifted).toBe(false)
	})

	it("moves a track already queued instead of duplicating it, keeping the current one", () => {
		const result = insertIntoQueue(queue, 2, false, [], [track("a"), track("c"), track("a")], "next")

		expect(uuids(result.queue)).toEqual(["b", "c", "a", "d"])
		expect(result.currentIndex).toBe(1)
		expect(result.added).toBe(1)
		expect(result.shifted).toBe(true)
	})

	it("is a no-op when only the current track is offered", () => {
		const result = insertIntoQueue(queue, 0, false, [], [track("a")], "end")

		expect(result.added).toBe(0)
		expect(result.queue).toBe(queue)
	})
})

describe("insertIntoQueue with shuffle", () => {
	it("plays Play next tracks next in shuffle order and keeps the rest of the order", () => {
		// Play order: c, a, d, b — current is c (index 2).
		const result = insertIntoQueue(queue, 2, true, [2, 0, 3, 1], [track("x"), track("y")], "next")

		expect(uuids(result.queue)).toEqual(["a", "b", "c", "x", "y", "d"])
		expect(result.currentIndex).toBe(2)
		expect(result.shuffleOrder.map(index => result.queue[index]?.uuid)).toEqual(["c", "x", "y", "a", "d", "b"])

		const next = computeNext({
			queueLength: result.queue.length,
			currentIndex: result.currentIndex,
			shuffleEnabled: true,
			shuffleOrder: result.shuffleOrder,
			loopMode: "off"
		})

		expect(next?.index).toBe(3)
	})

	it("puts Add to queue tracks after the rest of the lap", () => {
		const result = insertIntoQueue(queue, 2, true, [2, 0, 3, 1], [track("x")], "end")

		expect(result.shuffleOrder.map(index => result.queue[index]?.uuid)).toEqual(["c", "a", "d", "b", "x"])
	})

	it("rebuilds a stale order anchored at the current track first", () => {
		const result = insertIntoQueue(queue, 1, true, [0], [track("x")], "next", () => 0)

		expect(result.shuffleOrder).toHaveLength(5)
		expect(result.shuffleOrder[0]).toBe(result.currentIndex)
		expect(result.queue[result.shuffleOrder[1] ?? -1]?.uuid).toBe("x")
		expect(new Set(result.shuffleOrder).size).toBe(5)
	})

	it("drops a moved track from its old place in the order", () => {
		const result = insertIntoQueue(queue, 0, true, [0, 3, 1, 2], [track("b")], "next")

		expect(uuids(result.queue)).toEqual(["a", "b", "c", "d"])
		expect(result.shuffleOrder.map(index => result.queue[index]?.uuid)).toEqual(["a", "b", "d", "c"])
	})
})
