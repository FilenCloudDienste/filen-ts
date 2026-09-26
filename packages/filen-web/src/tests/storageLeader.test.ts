import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Each "tab" is a fresh import of the leader module over shared fakes: an exclusive Web Locks queue and
// an in-memory BroadcastChannel hub. The db worker is a stub whose open() resolves.

vi.mock("@/workers/db.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("comlink", () => ({
	wrap: () => ({ open: () => Promise.resolve(), kvGet: () => Promise.resolve("from-leader") })
}))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

type LockCallback = (lock: { name: string } | null) => unknown
interface Waiter {
	callback: LockCallback
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
}

class FakeLocks {
	private held = false
	private readonly queue: Waiter[] = []

	public request(name: string, optsOrCallback: object | LockCallback, maybeCallback?: LockCallback): Promise<unknown> {
		const opts = (typeof optsOrCallback === "function" ? {} : optsOrCallback) as { ifAvailable?: boolean; signal?: AbortSignal }
		const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as LockCallback

		return new Promise((resolve, reject) => {
			if (opts.ifAvailable && this.held) {
				queueMicrotask(() => {
					Promise.resolve(callback(null)).then(resolve, reject)
				})

				return
			}

			const waiter: Waiter = { callback, resolve, reject }

			opts.signal?.addEventListener("abort", () => {
				const index = this.queue.indexOf(waiter)

				if (index !== -1) {
					this.queue.splice(index, 1)
					reject(new DOMException("aborted", "AbortError"))
				}
			})
			this.queue.push(waiter)
			this.pump(name)
		})
	}

	// Holds the lock outside any tab (a page that is going away); the returned function releases it.
	public holdExternally(): () => void {
		this.held = true

		return () => {
			this.held = false
			this.pump("filen-web-db-leader")
		}
	}

	private pump(name: string): void {
		if (this.held) {
			return
		}

		const next = this.queue.shift()

		if (!next) {
			return
		}

		this.held = true
		queueMicrotask(() => {
			Promise.resolve(next.callback({ name })).then(
				value => {
					this.held = false
					next.resolve(value)
					this.pump(name)
				},
				(error: unknown) => {
					this.held = false
					next.reject(error)
					this.pump(name)
				}
			)
		})
	}
}

const channels = new Set<FakeChannel>()

class FakeChannel {
	public onmessage: ((ev: MessageEvent) => void) | null = null
	private readonly listeners: ((ev: MessageEvent) => void)[] = []

	public readonly name: string

	public constructor(name: string) {
		this.name = name
		channels.add(this)
	}

	public addEventListener(_type: "message", listener: (ev: MessageEvent) => void): void {
		this.listeners.push(listener)
	}

	public postMessage(data: unknown): void {
		for (const other of channels) {
			if (other !== this && other.name === this.name) {
				queueMicrotask(() => {
					other.deliver({ data } as MessageEvent)
				})
			}
		}
	}

	public close(): void {
		channels.delete(this)
	}

	private deliver(ev: MessageEvent): void {
		this.onmessage?.(ev)

		for (const listener of this.listeners) {
			listener(ev)
		}
	}
}

let locks: FakeLocks

async function openTab(): Promise<typeof import("@/lib/storage/leader")> {
	vi.resetModules()

	return await import("@/lib/storage/leader")
}

beforeEach(() => {
	vi.useFakeTimers()
	locks = new FakeLocks()
	channels.clear()
	vi.stubGlobal("navigator", { locks })
	vi.stubGlobal("BroadcastChannel", FakeChannel)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("acquireStorage", () => {
	it("leads when the lock is free", async () => {
		const tab = await openTab()
		const handle = await tab.acquireStorage()

		expect(handle.role).toBe("leader")
		expect(tab.storageRole()).toBe("leader")
	})

	it("follows a live leader and reaches it over the channel", async () => {
		await (await openTab()).acquireStorage()

		const second = await openTab()
		const acquired = second.acquireStorage()

		await vi.advanceTimersByTimeAsync(250)

		const handle = await acquired

		expect(handle.role).toBe("follower")
		expect(second.storageRole()).toBe("follower")
		await expect(handle.api.kvGet("k")).resolves.toBe("from-leader")
	})

	it("leads as soon as a departing page releases the lock, without waiting out the handshake", async () => {
		const release = locks.holdExternally()
		const tab = await openTab()
		const acquired = tab.acquireStorage()

		await vi.advanceTimersByTimeAsync(300)
		release()
		await vi.advanceTimersByTimeAsync(0)

		const handle = await acquired

		expect(handle.role).toBe("leader")
		expect(tab.storageRole()).toBe("leader")
		// The abandoned handshake stopped pinging and closed its channel; only the new leader's remains.
		expect(vi.getTimerCount()).toBe(0)
		expect(channels.size).toBe(1)
	})

	it("fails after 10s when the holder never answers, and does not take the lock afterwards", async () => {
		const release = locks.holdExternally()
		const tab = await openTab()
		const acquired = tab.acquireStorage()
		const outcome = acquired.catch((e: unknown) => e)

		await vi.advanceTimersByTimeAsync(10_000)

		expect(await outcome).toEqual(new Error("no db leader after 10s"))

		release()
		await vi.advanceTimersByTimeAsync(0)

		expect(tab.storageRole()).toBe(null)
	})

	it("promotes a follower in place when the leader goes away", async () => {
		const release = locks.holdExternally()
		const leaderChannel = new FakeChannel("filen-web-db-rpc")

		leaderChannel.onmessage = (ev: MessageEvent<{ kind: string }>) => {
			if (ev.data.kind === "leader?") {
				leaderChannel.postMessage({ kind: "leader-ready" })
			}
		}

		const tab = await openTab()
		const promotions = vi.fn()

		tab.onStorageLeadershipChange(promotions)

		const handle = await (async () => {
			const acquired = tab.acquireStorage()

			await vi.advanceTimersByTimeAsync(250)

			return await acquired
		})()

		expect(handle.role).toBe("follower")

		leaderChannel.close()
		release()
		await vi.advanceTimersByTimeAsync(0)

		expect(handle.role).toBe("leader")
		expect(tab.storageRole()).toBe("leader")
		expect(promotions).toHaveBeenCalledTimes(2)
	})
})
