// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createScreenWakeLock } from "@/lib/media/wakeLock"

// The screen wake lock's state machine, driven through an injected API and the real jsdom document
// with its visibilityState overridden.

class FakeSentinel {
	released = false
	readonly releaseCalls = vi.fn()
	private readonly listeners: (() => void)[] = []

	addEventListener(_type: "release", listener: () => void): void {
		this.listeners.push(listener)
	}

	release(): Promise<void> {
		this.releaseCalls()

		if (!this.released) {
			this.released = true

			for (const listener of this.listeners) {
				listener()
			}
		}

		return Promise.resolve()
	}

	// The browser drops the lock on its own (page hidden): released, the event fires, release() is not called.
	browserRelease(): void {
		this.released = true

		for (const listener of this.listeners) {
			listener()
		}
	}
}

function fakeApi() {
	const pending: ((sentinel: FakeSentinel) => void)[] = []
	const sentinels: FakeSentinel[] = []
	const request = vi.fn(
		(_type: "screen") =>
			new Promise<FakeSentinel>(resolve => {
				pending.push(resolve)
			})
	)

	return {
		api: { request },
		request,
		sentinels,
		// Answers the oldest outstanding request with a fresh sentinel.
		grant: async (): Promise<FakeSentinel> => {
			const resolve = pending.shift()

			if (resolve === undefined) {
				throw new Error("no outstanding request")
			}

			const sentinel = new FakeSentinel()

			sentinels.push(sentinel)
			resolve(sentinel)
			await flush()

			return sentinel
		}
	}
}

async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

let visibility: DocumentVisibilityState = "visible"

function setVisibility(next: DocumentVisibilityState): void {
	visibility = next
	document.dispatchEvent(new Event("visibilitychange"))
}

Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })

afterEach(() => {
	visibility = "visible"
	vi.restoreAllMocks()
})

describe("createScreenWakeLock", () => {
	it("returns inert handles when the lock is not needed", () => {
		const { api, request } = fakeApi()
		const lock = createScreenWakeLock({ needed: false, wakeLock: api, doc: document })

		lock.set(true)
		setVisibility("visible")
		lock.dispose()
		expect(request).not.toHaveBeenCalled()
	})

	it("returns inert handles without a wake lock API", () => {
		const add = vi.spyOn(document, "addEventListener")
		const lock = createScreenWakeLock({ needed: true, wakeLock: null, doc: document })

		lock.set(true)
		lock.dispose()
		expect(add).not.toHaveBeenCalledWith("visibilitychange", expect.anything())
	})

	it("asks only once the page is visible", async () => {
		visibility = "hidden"

		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)
		expect(request).not.toHaveBeenCalled()
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith("screen")

		const sentinel = await grant()

		expect(sentinel.releaseCalls).not.toHaveBeenCalled()
		lock.dispose()
	})

	it("releases a lock granted after it stopped being wanted", async () => {
		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)
		lock.set(false)
		expect(request).toHaveBeenCalledTimes(1)

		const late = await grant()

		expect(late.releaseCalls).toHaveBeenCalledTimes(1)
		expect(late.released).toBe(true)
		lock.dispose()
	})

	it("releases a lock granted after dispose", async () => {
		const { api, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)
		lock.dispose()

		const late = await grant()

		expect(late.releaseCalls).toHaveBeenCalledTimes(1)
	})

	it("makes one request for repeated set(true), pending or granted", async () => {
		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)
		lock.set(true)
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(1)
		await grant()
		lock.set(true)
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(1)
		lock.dispose()
	})

	it("releases the held lock on set(false)", async () => {
		const { api, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)

		const sentinel = await grant()

		lock.set(false)
		expect(sentinel.releaseCalls).toHaveBeenCalledTimes(1)
		lock.dispose()
		expect(sentinel.releaseCalls).toHaveBeenCalledTimes(1)
	})

	it("asks again on return to the page after the browser dropped the lock", async () => {
		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)

		const first = await grant()

		setVisibility("hidden")
		first.browserRelease()
		expect(request).toHaveBeenCalledTimes(1)
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(2)

		const second = await grant()

		lock.dispose()
		// Dropping skips release() on a sentinel the browser already released.
		expect(first.releaseCalls).not.toHaveBeenCalled()
		expect(second.releaseCalls).toHaveBeenCalledTimes(1)
	})

	it("does not ask again after the browser dropped the lock once it is no longer wanted", async () => {
		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)

		const first = await grant()

		first.browserRelease()
		lock.set(false)
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(1)
		lock.dispose()
	})

	it("asks again after a refused request", async () => {
		const request = vi.fn((_type: "screen") => Promise.reject<FakeSentinel>(new Error("NotAllowedError")))
		const lock = createScreenWakeLock({ needed: true, wakeLock: { request }, doc: document })

		lock.set(true)
		await flush()
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(2)
		lock.dispose()
	})

	it("dispose releases, removes its listener and ignores later set(true)", async () => {
		const remove = vi.spyOn(document, "removeEventListener")
		const { api, request, grant } = fakeApi()
		const lock = createScreenWakeLock({ needed: true, wakeLock: api, doc: document })

		lock.set(true)

		const sentinel = await grant()

		lock.dispose()
		expect(sentinel.releaseCalls).toHaveBeenCalledTimes(1)
		expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
		lock.set(true)
		setVisibility("visible")
		expect(request).toHaveBeenCalledTimes(1)
	})
})
