import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createQuitAfterDrag, QUIT_DRAG_WAIT_MS } from "../main/dragOut/quit.ts"

function fakes(running = true) {
	let ended: () => void = () => undefined
	const state = { running }
	const quit = vi.fn()
	const wait = createQuitAfterDrag({
		running: () => state.running,
		idle: () =>
			new Promise<void>(resolve => {
				ended = resolve
			}),
		quit
	})

	return {
		wait,
		quit,
		state,
		end: () => {
			state.running = false
			ended()
		}
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("quitting during a native drag", () => {
	it("does not defer while no drag runs", () => {
		const f = fakes(false)

		expect(f.wait.defer()).toBe(false)
	})

	it("defers once, then quits again when the drag ends", async () => {
		const f = fakes()

		expect(f.wait.defer()).toBe(true)
		expect(f.wait.defer()).toBe(true)
		f.end()
		await vi.advanceTimersByTimeAsync(0)

		expect(f.quit).toHaveBeenCalledOnce()
		expect(f.wait.defer()).toBe(false)
	})

	it("defers a later quit during another drag after a quit the page cancelled", async () => {
		const f = fakes()

		f.wait.defer()
		f.end()
		await vi.advanceTimersByTimeAsync(0)
		// The page's unload guard cancelled that quit.
		f.wait.reset()

		f.state.running = true
		expect(f.wait.defer()).toBe(true)
		f.end()
		await vi.advanceTimersByTimeAsync(0)
		expect(f.quit).toHaveBeenCalledTimes(2)
	})

	it("waits at most a few seconds for a drag whose end never comes, then lets the quit through", async () => {
		const f = fakes()

		f.wait.defer()
		await vi.advanceTimersByTimeAsync(QUIT_DRAG_WAIT_MS - 1)
		expect(f.quit).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(f.quit).toHaveBeenCalledOnce()
		// The drag still runs: this quit goes on (will-quit ends the drag).
		expect(f.wait.defer()).toBe(false)
	})

	it("a reset while waiting abandons the deferred quit", async () => {
		const f = fakes()

		f.wait.defer()
		f.wait.reset()
		f.end()
		await vi.advanceTimersByTimeAsync(QUIT_DRAG_WAIT_MS)

		expect(f.quit).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
