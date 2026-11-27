import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Each "tab" is a fresh import of the leader module over shared fakes: an exclusive Web Locks queue and
// an in-memory BroadcastChannel hub. The db worker is a stub whose open() resolves unless a test swaps it.

const worker = vi.hoisted(() => ({
	terminate: vi.fn(),
	release: vi.fn(),
	open: { current: (): Promise<void> => Promise.resolve() },
	kvGets: [] as string[],
	noteIndexPuts: [] as unknown[][]
}))

vi.mock("@/workers/db.worker.ts?worker", () => ({
	default: class {
		public terminate = worker.terminate
	}
}))
vi.mock("comlink", () => {
	const releaseProxy = Symbol("releaseProxy")

	return {
		releaseProxy,
		wrap: () => ({
			[releaseProxy]: worker.release,
			open: () => worker.open.current(),
			kvGet: (key: string) => {
				worker.kvGets.push(key)

				return Promise.resolve("from-leader")
			},
			noteIndexPut: (...args: unknown[]) => {
				worker.noteIndexPuts.push(args)

				return Promise.resolve()
			},
			kvPrefixBytes: (prefixes: string[]) => Promise.resolve(prefixes.map(prefix => prefix.length)),
			// A full VACUUM on a large database, well past the default RPC timeout.
			vacuum: () =>
				new Promise(resolve => {
					setTimeout(() => {
						resolve(4096)
					}, 30_000)
				}),
			kvKeys: () => new Promise(() => undefined),
			dumpLogs: () => Promise.resolve([{ t: 1, level: "warn", scope: "db.worker", msg: "from-leader" }])
		})
	}
})

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
const deliveries: { to: string; kind: unknown }[] = []

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
		if (!channels.has(this)) {
			return // closed while the message was queued
		}

		deliveries.push({ to: this.name, kind: (ev.data as { kind?: unknown }).kind })
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
	deliveries.length = 0
	worker.terminate.mockClear()
	worker.release.mockClear()
	worker.open.current = () => Promise.resolve()
	worker.kvGets.length = 0
	worker.noteIndexPuts.length = 0
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

		// No timer tick: the first handshake ping goes out immediately.
		await vi.advanceTimersByTimeAsync(0)

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
		// The abandoned handshake stopped pinging and closed its channel; only the new leader's remain.
		expect(vi.getTimerCount()).toBe(0)
		expect([...channels].map(ch => ch.name.split(":").slice(0, 2).join(":"))).toEqual(["filen-web-db-rpc", "filen-web-db-rpc:req"])
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
				leaderChannel.postMessage({ kind: "leader-ready", leader: "dead" })
			}
		}

		const tab = await openTab()
		const promotions = vi.fn()

		tab.onStorageLeadershipChange(promotions)

		const handle = await (async () => {
			const acquired = tab.acquireStorage()

			await vi.advanceTimersByTimeAsync(0)

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

describe("storageHasPeers", () => {
	it("stays false for a lone leader", async () => {
		const tab = await openTab()

		await tab.acquireStorage()
		await vi.advanceTimersByTimeAsync(1000)

		expect(tab.storageHasPeers()).toBe(false)
	})

	it("turns true on the leader once a follower reaches it", async () => {
		const first = await openTab()

		await first.acquireStorage()

		const second = await openTab()
		const acquired = second.acquireStorage()

		await vi.advanceTimersByTimeAsync(250)
		await acquired

		expect(first.storageHasPeers()).toBe(true)
	})

	it("is already true when a promoted follower announces leadership", async () => {
		const release = locks.holdExternally()
		const leaderChannel = new FakeChannel("filen-web-db-rpc")

		leaderChannel.onmessage = (ev: MessageEvent<{ kind: string }>) => {
			if (ev.data.kind === "leader?") {
				leaderChannel.postMessage({ kind: "leader-ready", leader: "dead" })
			}
		}

		const tab = await openTab()
		const seen: [string | null, boolean][] = []

		tab.onStorageLeadershipChange(() => {
			seen.push([tab.storageRole(), tab.storageHasPeers()])
		})

		const acquired = tab.acquireStorage()

		await vi.advanceTimersByTimeAsync(250)
		await acquired

		leaderChannel.close()
		release()
		await vi.advanceTimersByTimeAsync(0)

		expect(seen).toEqual([
			["follower", false],
			["leader", true]
		])
	})
})

describe("follower RPC", () => {
	async function follower() {
		await (await openTab()).acquireStorage()

		const acquired = (await openTab()).acquireStorage()

		await vi.advanceTimersByTimeAsync(0)

		return (await acquired).api
	}

	it("reaches kvPrefixBytes on the leader", async () => {
		const api = await follower()

		await expect(api.kvPrefixBytes(["rq.", "audio.v1.tags."])).resolves.toEqual([3, 14])
	})

	it("runs a follower's search index write on the leader's worker", async () => {
		const api = await follower()
		const rows = [{ uuid: "a", edited: "1", text: "note text" }]

		await api.noteIndexPut("account", rows)

		expect(worker.noteIndexPuts).toEqual([["account", rows]])
	})

	it("reaches dumpLogs on the leader", async () => {
		const api = await follower()

		await expect(api.dumpLogs()).resolves.toEqual([{ t: 1, level: "warn", scope: "db.worker", msg: "from-leader" }])
	})

	it("waits out a vacuum that runs past the default timeout", async () => {
		const api = await follower()
		const vacuumed = api.vacuum()

		await vi.advanceTimersByTimeAsync(30_000)

		await expect(vacuumed).resolves.toBe(4096)
	})

	it("still times out other calls after 5s", async () => {
		const api = await follower()
		const keys = api.kvKeys("").catch((e: unknown) => e)

		await vi.advanceTimersByTimeAsync(5000)

		expect(await keys).toEqual(new Error("db rpc timeout: kvKeys"))
	})
})

// A leader in another tab, seen only through its hello channel: it answers the handshake with `id`.
function remoteLeader(id: string): FakeChannel {
	const hello = new FakeChannel("filen-web-db-rpc")

	hello.onmessage = (ev: MessageEvent<{ kind: string }>) => {
		if (ev.data.kind === "leader?") {
			hello.postMessage({ kind: "leader-ready", leader: id })
		}
	}

	return hello
}

async function followRemoteLeader(id: string) {
	const release = locks.holdExternally()
	const hello = remoteLeader(id)
	const tab = await openTab()
	const acquired = tab.acquireStorage()

	await vi.advanceTimersByTimeAsync(0)

	return { tab, handle: await acquired, hello, release }
}

function channelKinds(): string[] {
	return [...channels].map(ch => ch.name.split(":").slice(0, 2).join(":")).sort()
}

describe("leader hand-over", () => {
	it("runs calls in flight at the leader's death and calls made during the promotion on the new leader, in order", async () => {
		const { tab, handle, hello, release } = await followRemoteLeader("dead")
		const inFlight = handle.api.kvGet("in-flight")
		const opened = Promise.withResolvers<undefined>()

		worker.open.current = () => opened.promise
		await vi.advanceTimersByTimeAsync(0)
		hello.close()
		release()
		await vi.advanceTimersByTimeAsync(0)

		const during = handle.api.kvGet("during")

		// Longer than the RPC timeout: held calls do not time out while the promotion runs.
		await vi.advanceTimersByTimeAsync(10_000)
		opened.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)

		await expect(inFlight).resolves.toBe("from-leader")
		await expect(during).resolves.toBe("from-leader")
		expect(worker.kvGets).toEqual(["in-flight", "during"])
		expect(handle.role).toBe("leader")
		expect(tab.storageRole()).toBe("leader")
		// The follower's channels are closed; only the new leader's hello and request channels remain.
		expect(channelKinds()).toEqual(["filen-web-db-rpc", "filen-web-db-rpc:req"])
	})

	it("fails the held calls with the promotion's error and terminates the worker", async () => {
		const { tab, handle, hello, release } = await followRemoteLeader("dead")
		const inFlight = handle.api.kvGet("in-flight").catch((e: unknown) => e)
		const opened = Promise.withResolvers<undefined>()
		const failure = new Error("opfs gone")

		worker.open.current = () => opened.promise
		await vi.advanceTimersByTimeAsync(0)
		hello.close()
		release()
		await vi.advanceTimersByTimeAsync(0)

		const during = handle.api.kvGet("during").catch((e: unknown) => e)

		opened.reject(failure)
		await vi.advanceTimersByTimeAsync(0)

		expect(await inFlight).toBe(failure)
		expect(await during).toBe(failure)
		expect(worker.kvGets).toEqual([])
		expect(worker.terminate).toHaveBeenCalledTimes(1)
		expect(worker.release).toHaveBeenCalledTimes(1)
		expect(handle.role).toBe("follower")
		expect(tab.storageRole()).toBe("follower")
	})

	it("re-posts unanswered calls to the next leader when it announces itself", async () => {
		const { handle, hello } = await followRemoteLeader("dead")
		const lost = handle.api.kvGet("k")
		const requests = new FakeChannel("filen-web-db-rpc:req:next")

		requests.onmessage = (ev: MessageEvent<{ id: string; tab: string }>) => {
			new FakeChannel(`filen-web-db-rpc:res:${ev.data.tab}`).postMessage({
				kind: "res",
				id: ev.data.id,
				ok: true,
				value: "from-next"
			})
		}

		await vi.advanceTimersByTimeAsync(1000)
		hello.postMessage({ kind: "leader-ready", leader: "next" })
		await vi.advanceTimersByTimeAsync(0)

		await expect(lost).resolves.toBe("from-next")
	})
})

describe("becomeLeader", () => {
	it("terminates the worker and rethrows when open() rejects", async () => {
		const failure = new Error("opfs gone")

		worker.open.current = () => Promise.reject(failure)

		const tab = await openTab()

		await expect(tab.acquireStorage()).rejects.toBe(failure)
		expect(worker.terminate).toHaveBeenCalledTimes(1)
		expect(worker.release).toHaveBeenCalledTimes(1)
	})
})

describe("follower RPC transport", () => {
	async function follower() {
		const acquired = (await openTab()).acquireStorage()

		await vi.advanceTimersByTimeAsync(0)

		return (await acquired).api
	}

	it("leaves no timer behind for an answered call, and the leader closes an idle response channel", async () => {
		await (await openTab()).acquireStorage()

		const api = await follower()

		await expect(api.kvGet("k")).resolves.toBe("from-leader")
		// Only the leader's idle timer for the follower's response channel is left.
		expect(vi.getTimerCount()).toBe(1)
		expect(channelKinds().filter(kind => kind.endsWith(":res"))).toHaveLength(2)

		await vi.advanceTimersByTimeAsync(30_000)

		expect(vi.getTimerCount()).toBe(0)
		expect(channelKinds().filter(kind => kind.endsWith(":res"))).toHaveLength(1)
	})

	it("delivers a request only to the leader and a response only to the follower that asked", async () => {
		await (await openTab()).acquireStorage()

		const a = await follower()

		await follower()
		deliveries.length = 0

		await expect(a.kvGet("k")).resolves.toBe("from-leader")
		expect(
			deliveries
				.filter(d => d.kind === "req" || d.kind === "res")
				.map(d => `${d.to.split(":").slice(0, 2).join(":")} ${String(d.kind)}`)
		).toEqual(["filen-web-db-rpc:req req", "filen-web-db-rpc:res res"])
	})
})
