import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cancelHeldPause, hasHeldPause, HELD_PAUSE_MAX_MS, pauseMedia, type PausableMedia } from "@filen/shared/heldPause"

class FakeMedia implements PausableMedia {
	seeking = false
	pauses = 0
	private readonly listeners = new Map<string, Set<() => void>>()

	pause(): void {
		this.pauses++
	}

	addEventListener(type: string, listener: () => void): void {
		const set = this.listeners.get(type) ?? new Set()

		set.add(listener)
		this.listeners.set(type, set)
	}

	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener)
	}

	fire(type: string): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener()
		}
	}

	listenerCount(): number {
		return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0)
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("pauseMedia", () => {
	it("pauses at once when no seek is in flight, holding nothing", () => {
		const media = new FakeMedia()

		pauseMedia(media)

		expect(media.pauses).toBe(1)
		expect(hasHeldPause(media)).toBe(false)
		expect(media.listenerCount()).toBe(0)
	})

	it("holds a pause asked for mid-seek until the seek lands", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)

		expect(media.pauses).toBe(0)
		expect(hasHeldPause(media)).toBe(true)

		media.seeking = false
		media.fire("seeked")

		expect(media.pauses).toBe(1)
		expect(hasHeldPause(media)).toBe(false)
		expect(media.listenerCount()).toBe(0)
	})

	it("makes the pause anyway when the seek never lands", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)
		vi.advanceTimersByTime(HELD_PAUSE_MAX_MS - 1)

		expect(media.pauses).toBe(0)

		vi.advanceTimersByTime(1)

		expect(media.pauses).toBe(1)
		expect(media.listenerCount()).toBe(0)
	})

	it("pauses once, whichever of seeked and the bound comes first", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)
		media.fire("seeked")
		vi.advanceTimersByTime(HELD_PAUSE_MAX_MS)

		expect(media.pauses).toBe(1)
	})

	it("treats a second pause during the hold as the same one", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)
		pauseMedia(media)
		media.fire("seeked")

		expect(media.pauses).toBe(1)
		expect(media.listenerCount()).toBe(0)
	})

	it("drops the held pause when playing is asked for", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)

		expect(cancelHeldPause(media)).toBe(true)

		media.fire("seeked")
		vi.advanceTimersByTime(HELD_PAUSE_MAX_MS)

		expect(media.pauses).toBe(0)
		expect(media.listenerCount()).toBe(0)
		expect(cancelHeldPause(media)).toBe(false)
	})

	it("drops the held pause when the element is emptied", () => {
		const media = new FakeMedia()

		media.seeking = true
		pauseMedia(media)
		media.fire("emptied")
		vi.advanceTimersByTime(HELD_PAUSE_MAX_MS)

		expect(media.pauses).toBe(0)
		expect(hasHeldPause(media)).toBe(false)
		expect(media.listenerCount()).toBe(0)
	})
})
