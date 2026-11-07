import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hasHeldPause, type PausableMedia } from "@filen/shared/heldPause"
import { playMedia, toggleMediaPlayback } from "@/lib/media/useMediaState"

class FakeMedia implements PausableMedia {
	seeking = false
	paused = false
	ended = false
	pauses = 0
	plays = 0

	play(): Promise<void> {
		this.plays++
		this.paused = false

		return Promise.resolve()
	}
	private readonly listeners = new Map<string, Set<() => void>>()

	pause(): void {
		this.pauses++
		this.paused = true
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
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("toggleMediaPlayback and playMedia with a held pause", () => {
	it("pauses a playing element through the hold while it seeks", () => {
		const media = new FakeMedia()

		media.seeking = true
		toggleMediaPlayback(media)

		expect(media.pauses).toBe(0)
		expect(hasHeldPause(media)).toBe(true)
	})

	it("takes a second press during the hold as play: the pause is dropped and the element plays on", () => {
		const media = new FakeMedia()

		media.seeking = true
		toggleMediaPlayback(media)
		toggleMediaPlayback(media)
		media.fire("seeked")

		expect(media.pauses).toBe(0)
		expect(media.plays).toBe(0)
		expect(media.paused).toBe(false)
	})

	it("drops the held pause when playing is asked for", () => {
		const media = new FakeMedia()

		media.seeking = true
		toggleMediaPlayback(media)
		playMedia(media)
		media.fire("seeked")

		expect(media.pauses).toBe(0)
		expect(media.plays).toBe(1)
	})

	it("plays a paused element and pauses a playing one when no seek is in flight", () => {
		const media = new FakeMedia()

		toggleMediaPlayback(media)
		expect(media.pauses).toBe(1)

		toggleMediaPlayback(media)
		expect(media.plays).toBe(1)
	})
})
