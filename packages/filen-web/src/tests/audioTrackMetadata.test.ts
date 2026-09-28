import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

const { fakeKv } = vi.hoisted(() => ({ fakeKv: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				kvGet: (key: string) => Promise.resolve(fakeKv.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeKv.set(key, value)

					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeKv.delete(key)

					return Promise.resolve()
				},
				kvEntries: (prefix: string) => Promise.resolve([...fakeKv.entries()].filter(([key]) => key.startsWith(prefix)))
			}
		})
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ readThumbnailBlob: vi.fn(), deleteThumbnail: vi.fn() }))

const { TrackMetadataService } = await import("@/features/audio/lib/trackMetadata")
const { JobQueue } = await import("@/features/audio/lib/trackMetadata.logic")
const { planTrackTagEvictions, trackTagsKey, trackDisplayTitle } = await import("@/features/audio/lib/trackTags.logic")
const { backfillTrackDuration, getTrackTags, hydrateTrackTags, putTrackTags, resetTrackTags, useTrackTagsStore } =
	await import("@/features/audio/store/useTrackTagsStore")
const { stringifyEnvelope } = await import("@/lib/serialize")

import type { AudioMetadataResult } from "@/workers/audioMetadata"
import type { TrackMetadataDeps } from "@/features/audio/lib/trackMetadata"
import type { TrackTagRecord } from "@/features/audio/lib/trackTags.logic"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: `${uuid}.mp3`, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

function record(overrides: Partial<TrackTagRecord> = {}): TrackTagRecord {
	return { title: "T", artist: null, album: null, durationSec: null, cover: false, parsed: true, at: 1, ...overrides }
}

function parsed(thumbnail: Uint8Array | null = null): AudioMetadataResult {
	return { type: "parsed", tags: { title: "Song", artist: "Band", album: "Album", durationSec: 200 }, thumbnail }
}

async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) {
		await Promise.resolve()
	}
}

interface Deferred<T> {
	promise: Promise<T>
	resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve } = Promise.withResolvers<T>()

	return { promise, resolve }
}

function makeService(overrides: Partial<TrackMetadataDeps> = {}) {
	let urls = 0
	const deps = {
		readRemote: vi.fn<TrackMetadataDeps["readRemote"]>(() => Promise.resolve(parsed())),
		readLocal: vi.fn<TrackMetadataDeps["readLocal"]>(() => Promise.resolve(parsed())),
		cancelRead: vi.fn<TrackMetadataDeps["cancelRead"]>(),
		readThumbnail: vi.fn<TrackMetadataDeps["readThumbnail"]>(() => Promise.resolve(null)),
		createObjectUrl: vi.fn<TrackMetadataDeps["createObjectUrl"]>(() => `blob:${String(++urls)}`),
		revokeObjectUrl: vi.fn<TrackMetadataDeps["revokeObjectUrl"]>(),
		isOnline: vi.fn<TrackMetadataDeps["isOnline"]>(() => true),
		now: () => 42
	}

	return { service: new TrackMetadataService({ ...deps, ...overrides }), deps }
}

beforeEach(() => {
	fakeKv.clear()
	resetTrackTags()
})

describe("JobQueue", () => {
	it("runs at most `concurrency` jobs, FIFO, with priority jobs first", async () => {
		const queue = new JobQueue(2)
		const order: string[] = []
		const gates = new Map<string, Deferred<undefined>>()

		function job(name: string): () => Promise<void> {
			const gate = deferred<undefined>()

			gates.set(name, gate)

			return () => {
				order.push(name)

				return gate.promise
			}
		}

		queue.enqueue(job("a"), false)
		queue.enqueue(job("b"), false)
		queue.enqueue(job("c"), false)
		queue.enqueue(job("d"), true)

		expect(order).toEqual(["a", "b"])
		expect(queue.pendingCount).toBe(2)

		gates.get("a")?.resolve(undefined)
		await flush()

		expect(order).toEqual(["a", "b", "d"])

		gates.get("b")?.resolve(undefined)
		await flush()

		expect(order).toEqual(["a", "b", "d", "c"])
	})

	it("drops a waiting job on cancel, moves one forward on prioritize, and never cancels a running one", async () => {
		const queue = new JobQueue(1)
		const gate = deferred<undefined>()
		const ran: string[] = []

		const running = queue.enqueue(() => {
			ran.push("a")

			return gate.promise
		}, false)
		const dropped = queue.enqueue(() => {
			ran.push("b")

			return Promise.resolve()
		}, false)

		queue.enqueue(() => {
			ran.push("c")

			return Promise.resolve()
		}, false)

		const promoted = queue.enqueue(() => {
			ran.push("d")

			return Promise.resolve()
		}, false)

		running.cancel()
		dropped.cancel()
		promoted.prioritize()
		gate.resolve(undefined)
		await flush()

		expect(ran).toEqual(["a", "d", "c"])
	})
})

describe("trackTags.logic", () => {
	it("plans evictions oldest first, only past the cap", () => {
		const records: [string, TrackTagRecord][] = [
			["new", record({ at: 30 })],
			["old", record({ at: 10 })],
			["mid", record({ at: 20 })]
		]

		expect(planTrackTagEvictions(records, 3)).toEqual([])
		expect(planTrackTagEvictions(records, 1)).toEqual(["old", "mid"])
	})

	it("titles a track from its tags, falling back to the file name", () => {
		expect(trackDisplayTitle(record({ title: "Song" }), "a.mp3")).toBe("Song")
		expect(trackDisplayTitle(record({ title: null }), "a.mp3")).toBe("a.mp3")
		expect(trackDisplayTitle(undefined, "a.mp3")).toBe("a.mp3")
	})
})

describe("useTrackTagsStore", () => {
	it("hydrates every valid persisted record in one read and drops invalid ones", async () => {
		fakeKv.set(trackTagsKey("a"), stringifyEnvelope(record({ title: "A" })))
		fakeKv.set(trackTagsKey("bad"), stringifyEnvelope({ title: 5 }))
		fakeKv.set("unrelated", stringifyEnvelope({}))

		await hydrateTrackTags()

		expect(useTrackTagsStore.getState().hydrated).toBe(true)
		expect(useTrackTagsStore.getState().byUuid).toEqual({ a: record({ title: "A" }) })
	})

	it("keeps a record written while hydration was in flight over the persisted one", async () => {
		fakeKv.set(trackTagsKey("a"), stringifyEnvelope(record({ title: "old" })))

		const hydration = hydrateTrackTags()

		putTrackTags("a", record({ title: "new" }))
		await hydration

		expect(getTrackTags("a")?.title).toBe("new")
	})

	it("persists every write", async () => {
		putTrackTags("a", record({ title: "A" }))
		await flush()

		expect(fakeKv.has(trackTagsKey("a"))).toBe(true)
	})

	it("fills a missing duration from the element, remembers one that arrives before the record, and never overrides a tag", () => {
		putTrackTags("a", record())
		backfillTrackDuration("a", 61.6)
		expect(getTrackTags("a")?.durationSec).toBe(62)

		backfillTrackDuration("b", 30)
		putTrackTags("b", record())
		expect(getTrackTags("b")?.durationSec).toBe(30)

		putTrackTags("c", record({ durationSec: 100 }))
		backfillTrackDuration("c", 5)
		expect(getTrackTags("c")?.durationSec).toBe(100)
	})

	it("discards a hydration that lands after a reset", async () => {
		fakeKv.set(trackTagsKey("a"), stringifyEnvelope(record()))

		const hydration = hydrateTrackTags()

		resetTrackTags()
		await hydration

		expect(useTrackTagsStore.getState()).toMatchObject({ byUuid: {}, hydrated: false })
	})
})

describe("TrackMetadataService", () => {
	it("reads a track once, persists its tags, and keeps its cover thumbnail URL", async () => {
		const { service, deps } = makeService()

		deps.readRemote.mockResolvedValue(parsed(new Uint8Array([1, 2])))

		const outcome = await service.request(track("a")).promise

		expect(outcome).toMatchObject({ type: "ready", record: { title: "Song", cover: true, parsed: true, at: 42 } })
		expect(getTrackTags("a")?.durationSec).toBe(200)
		expect(service.peekCoverUrl("a")).toBe("blob:1")

		await service.request(track("a")).promise

		expect(deps.readRemote).toHaveBeenCalledTimes(1)
	})

	it("shares one read between concurrent requests for the same track", async () => {
		const { service, deps } = makeService()
		const gate = deferred<AudioMetadataResult>()

		deps.readRemote.mockReturnValue(gate.promise)

		const first = service.request(track("a"))
		const second = service.request(track("a"))

		gate.resolve(parsed())

		expect(await first.promise).toEqual(await second.promise)
		expect(deps.readRemote).toHaveBeenCalledTimes(1)
	})

	it("drops a queued read nobody wants any more, but keeps one another caller still wants", async () => {
		const { service, deps } = makeService()
		const gates = [deferred<AudioMetadataResult>(), deferred<AudioMetadataResult>()]

		deps.readRemote
			.mockReturnValueOnce(gates[0]?.promise ?? Promise.resolve(parsed()))
			.mockReturnValueOnce(gates[1]?.promise ?? Promise.resolve(parsed()))

		service.request(track("a"))
		service.request(track("b"))
		await flush()

		const unwanted = service.request(track("c"))
		const shared = service.request(track("d"))

		service.request(track("d"))
		unwanted.cancel()
		shared.cancel()

		expect(await unwanted.promise).toEqual({ type: "unavailable" })

		gates[0]?.resolve(parsed())
		gates[1]?.resolve(parsed())
		await flush()

		expect(deps.readRemote.mock.calls.map(([t]) => t.uuid)).toEqual(["a", "b", "d"])
	})

	it("records an unparseable file as final, so it is never read again", async () => {
		const { service, deps } = makeService()

		deps.readRemote.mockResolvedValue({ type: "unparseable" })

		await service.request(track("a")).promise
		await service.request(track("a")).promise

		expect(getTrackTags("a")).toMatchObject({ parsed: false, cover: false, title: null })
		expect(deps.readRemote).toHaveBeenCalledTimes(1)
	})

	it("gives up on a track after repeated read failures until the connection comes back", async () => {
		const { service, deps } = makeService()

		deps.readRemote.mockResolvedValue({ type: "readFailed" })

		for (let i = 0; i < 4; i++) {
			expect(await service.request(track("a")).promise).toEqual({ type: "unavailable" })
		}

		expect(deps.readRemote).toHaveBeenCalledTimes(3)
		expect(getTrackTags("a")).toBeUndefined()

		service.onReconnect()
		await service.request(track("a")).promise

		expect(deps.readRemote).toHaveBeenCalledTimes(4)
	})

	it("reads nothing offline, except bytes already in memory", async () => {
		const { service, deps } = makeService({ isOnline: () => false })

		expect(await service.request(track("a")).promise).toEqual({ type: "unavailable" })
		expect(deps.readRemote).not.toHaveBeenCalled()

		await service.request(track("b"), { local: new Blob(["x"]) }).promise

		expect(deps.readLocal).toHaveBeenCalledTimes(1)
	})

	it("adopts a record another tab persisted instead of reading the track again", async () => {
		const { service, deps } = makeService()

		await hydrateTrackTags()
		fakeKv.set(trackTagsKey("a"), stringifyEnvelope(record({ title: "From another tab" })))

		expect(await service.request(track("a")).promise).toMatchObject({ type: "ready", record: { title: "From another tab" } })
		expect(deps.readRemote).not.toHaveBeenCalled()
	})

	it("re-reads a track for an evicted cover at most once per session", async () => {
		const { service, deps } = makeService()

		putTrackTags("a", record({ cover: true }))

		await service.request(track("a"), { refresh: true }).promise
		await service.request(track("a"), { refresh: true }).promise

		expect(deps.readRemote).toHaveBeenCalledTimes(1)
	})

	it("loads a cover URL from the thumbnail cache without reading the track", async () => {
		const { service, deps } = makeService()

		deps.readThumbnail.mockResolvedValue(new Blob(["thumb"]))

		expect(await service.loadCoverUrl("a")).toBe("blob:1")
		expect(await service.loadCoverUrl("a")).toBe("blob:1")
		expect(deps.readThumbnail).toHaveBeenCalledTimes(1)
		expect(deps.readRemote).not.toHaveBeenCalled()
	})

	describe("playbackCover", () => {
		it("costs nothing for a track known to have no cover", async () => {
			const { service, deps } = makeService()

			putTrackTags("a", record({ cover: false }))

			expect(await service.playbackCover(track("a"))).toEqual({ cover: null })
			expect(deps.readThumbnail).not.toHaveBeenCalled()
			expect(deps.readRemote).not.toHaveBeenCalled()
		})

		it("serves a known cover from the thumbnail cache", async () => {
			const { service, deps } = makeService()
			const thumb = new Blob(["thumb"])

			putTrackTags("a", record({ cover: true }))
			deps.readThumbnail.mockResolvedValue(thumb)

			expect(await service.playbackCover(track("a"))).toEqual({ cover: thumb })
			expect(deps.readRemote).not.toHaveBeenCalled()
		})

		it("reads a new track from the Blob the player holds, without a download", async () => {
			const { service, deps } = makeService()
			const bytes = new Blob(["audio"])

			deps.readLocal.mockResolvedValue(parsed(new Uint8Array([5])))

			const result = await service.playbackCover(track("a"), bytes)

			expect(result?.cover).toBeInstanceOf(Blob)
			expect(deps.readLocal).toHaveBeenCalledWith(bytes, "a", expect.any(String))
			expect(deps.readRemote).not.toHaveBeenCalled()
		})

		it("resolves null when the track could not be read", async () => {
			const { service, deps } = makeService()

			deps.readRemote.mockResolvedValue({ type: "readFailed" })

			expect(await service.playbackCover(track("a"))).toBeNull()
		})
	})

	it("reset aborts running reads, drops waiting ones, revokes every cover URL and forgets every tag", async () => {
		const { service, deps } = makeService()

		deps.readThumbnail.mockResolvedValue(new Blob(["thumb"]))
		await service.loadCoverUrl("x")

		const gate = deferred<AudioMetadataResult>()

		deps.readRemote.mockReturnValue(gate.promise)

		const running = service.request(track("a"))

		service.request(track("b"))
		service.request(track("c"))
		await flush()
		putTrackTags("z", record())

		service.reset()

		expect(deps.cancelRead).toHaveBeenCalledTimes(2)
		expect(deps.revokeObjectUrl).toHaveBeenCalledWith("blob:1")
		expect(await running.promise).toEqual({ type: "unavailable" })
		expect(getTrackTags("z")).toBeUndefined()

		gate.resolve(parsed())
		await flush()

		expect(getTrackTags("a")).toBeUndefined()
		expect(deps.readRemote).toHaveBeenCalledTimes(2)
	})
})
