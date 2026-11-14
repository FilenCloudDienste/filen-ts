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

vi.mock("@/features/drive/lib/thumbCache", () => ({ readThumbnailBlob: vi.fn(), deleteThumbnail: vi.fn() }))

const { TrackMetadataService } = await import("@/features/audio/lib/trackMetadata")
const { JobQueue } = await import("@/features/audio/lib/trackMetadata.logic")
const { planTrackTagEvictions, trackTagsKey, trackDisplayTitle, TRACK_TAGS_MAX_RECORDS } =
	await import("@/features/audio/lib/trackTags.logic")
const { trackEdgesKey } = await import("@/features/audio/lib/trackEdges.logic")
const { backfillTrackDuration, getTrackTags, hydrateTrackTags, putTrackTags, resetTrackTags, useTrackTagsStore } =
	await import("@/features/audio/store/useTrackTagsStore")
const { stringifyEnvelope } = await import("@filen/shared/session")

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

const GAIN = { trackDb: -7.5, trackPeak: 0.9, albumDb: null, albumPeak: null }

function parsed(thumbnail: Uint8Array | null = null): AudioMetadataResult {
	return { type: "parsed", tags: { title: "Song", artist: "Band", album: "Album", durationSec: 200 }, gain: GAIN, thumbnail }
}

async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) {
		await Promise.resolve()
	}
}

function makeService(overrides: Partial<TrackMetadataDeps> = {}) {
	let urls = 0
	const deps = {
		readRemote: vi.fn<TrackMetadataDeps["readRemote"]>(() => Promise.resolve(parsed())),
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
		const gates = new Map<string, PromiseWithResolvers<undefined>>()

		function job(name: string): () => Promise<void> {
			const gate = Promise.withResolvers<undefined>()

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
		const gate = Promise.withResolvers<undefined>()
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
		expect(trackDisplayTitle(null, "a.mp3")).toBe("a.mp3")
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

	it("notifies subscribers on every write with a new state and only the written record changed", () => {
		putTrackTags("a", record({ title: "A" }))

		const before = useTrackTagsStore.getState()
		const recordA = before.byUuid["a"]
		const seen: (string | null | undefined)[] = []
		const unsubscribe = useTrackTagsStore.subscribe(state => {
			seen.push(state.byUuid["b"]?.title)
		})

		putTrackTags("b", record({ title: "B" }))
		backfillTrackDuration("b", 10)
		unsubscribe()

		const after = useTrackTagsStore.getState()

		expect(seen).toEqual(["B", "B"])
		expect(after).not.toBe(before)
		expect(after.byUuid["a"]).toBe(recordA)
		expect(after.byUuid["b"]).toEqual(record({ title: "B", durationSec: 10 }))
	})

	it("hydrates a record from before ReplayGain was read (no gain) next to one that carries it", async () => {
		fakeKv.set(trackTagsKey("old"), stringifyEnvelope(record({ title: "Old" })))
		fakeKv.set(trackTagsKey("new"), stringifyEnvelope(record({ title: "New", gain: GAIN })))
		fakeKv.set(trackTagsKey("bad"), stringifyEnvelope(record({ gain: { trackDb: "loud" } as never })))

		await hydrateTrackTags()

		expect(getTrackTags("old")).toEqual(record({ title: "Old" }))
		expect(getTrackTags("old")?.gain).toBeUndefined()
		expect(getTrackTags("new")?.gain).toEqual(GAIN)
		expect(getTrackTags("bad")).toBeUndefined()
	})

	it("deletes an evicted track's edge analysis with its tags", async () => {
		for (let i = 0; i <= TRACK_TAGS_MAX_RECORDS; i++) {
			fakeKv.set(trackTagsKey(`t${String(i)}`), stringifyEnvelope(record({ at: i + 1 })))
		}

		fakeKv.set(trackEdgesKey("t0"), stringifyEnvelope({ v: "x" }))
		fakeKv.set(trackEdgesKey("t1"), stringifyEnvelope({ v: "x" }))

		await hydrateTrackTags()
		await flush()

		expect(fakeKv.has(trackTagsKey("t0"))).toBe(false)
		expect(fakeKv.has(trackEdgesKey("t0"))).toBe(false)
		expect(fakeKv.has(trackTagsKey("t1"))).toBe(true)
		expect(fakeKv.has(trackEdgesKey("t1"))).toBe(true)
	})

	it("starts from an empty record map after a reset that followed writes", () => {
		putTrackTags("a", record({ title: "A" }))

		const written = useTrackTagsStore.getState().byUuid

		resetTrackTags()

		expect(useTrackTagsStore.getState().byUuid).toEqual({})
		expect(useTrackTagsStore.getState().byUuid).not.toBe(written)
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
		const gate = Promise.withResolvers<AudioMetadataResult>()

		deps.readRemote.mockReturnValue(gate.promise)

		const first = service.request(track("a"))
		const second = service.request(track("a"))

		gate.resolve(parsed())

		expect(await first.promise).toEqual(await second.promise)
		expect(deps.readRemote).toHaveBeenCalledTimes(1)
	})

	it("drops a queued read nobody wants any more, but keeps one another caller still wants", async () => {
		const { service, deps } = makeService()
		// One per concurrent read, so the two below wait in the queue.
		const busy = ["a", "b", "e", "f"]
		const gates = busy.map(() => Promise.withResolvers<AudioMetadataResult>())

		for (const gate of gates) {
			deps.readRemote.mockReturnValueOnce(gate.promise)
		}

		for (const uuid of busy) {
			service.request(track(uuid))
		}

		await flush()

		const unwanted = service.request(track("c"))
		const shared = service.request(track("d"))

		service.request(track("d"))
		unwanted.cancel()
		shared.cancel()

		expect(await unwanted.promise).toEqual({ type: "unavailable" })

		for (const gate of gates) {
			gate.resolve(parsed())
		}

		await flush()

		expect(deps.readRemote.mock.calls.map(([t]) => t.uuid)).toEqual([...busy, "d"])
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

	it("reads nothing offline", async () => {
		const { service, deps } = makeService({ isOnline: () => false })

		expect(await service.request(track("a")).promise).toEqual({ type: "unavailable" })
		expect(deps.readRemote).not.toHaveBeenCalled()
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

	it("writes the gain with every new parse, and reads the cover with it", async () => {
		const { service, deps } = makeService()

		expect(await service.request(track("a")).promise).toMatchObject({ type: "ready", record: { gain: GAIN } })
		expect(getTrackTags("a")?.gain).toEqual(GAIN)
		expect(deps.readRemote).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), expect.any(String), { skipCover: false })
	})

	describe("refreshGain", () => {
		it("re-reads a record without gain, skipping the cover, and keeps its cover flag", async () => {
			const { service, deps } = makeService()

			putTrackTags("a", record({ title: "Kept", cover: true, at: 1 }))
			deps.readRemote.mockResolvedValue(parsed(null))

			const outcome = await service.request(track("a"), { priority: true, refreshGain: true }).promise

			expect(deps.readRemote).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), expect.any(String), { skipCover: true })
			expect(outcome).toEqual({ type: "ready", record: record({ title: "Kept", cover: true, gain: GAIN, at: 42 }), thumbnail: null })
			expect(getTrackTags("a")).toEqual(record({ title: "Kept", cover: true, gain: GAIN, at: 42 }))
			expect(service.peekCoverUrl("a")).toBeNull()
			expect(deps.createObjectUrl).not.toHaveBeenCalled()
		})

		it("costs nothing for a record that already has its gain, or one the parser could not read", async () => {
			const { service, deps } = makeService()

			putTrackTags("a", record({ gain: GAIN }))
			putTrackTags("b", record({ parsed: false }))

			expect(await service.request(track("a"), { refreshGain: true }).promise).toMatchObject({ record: { gain: GAIN } })
			expect(await service.request(track("b"), { refreshGain: true }).promise).toMatchObject({ record: { parsed: false } })
			expect(deps.readRemote).not.toHaveBeenCalled()
		})

		it("re-reads at most once per session, on a guard of its own that leaves the cover refresh alone", async () => {
			const { service, deps } = makeService()

			putTrackTags("a", record({ cover: true }))
			deps.readRemote.mockResolvedValue({ type: "readFailed" })

			await service.request(track("a"), { refreshGain: true }).promise
			await service.request(track("a"), { refreshGain: true }).promise

			expect(deps.readRemote).toHaveBeenCalledTimes(1)

			deps.readRemote.mockResolvedValue(parsed(new Uint8Array([1])))

			expect(await service.request(track("a"), { refresh: true }).promise).toMatchObject({ type: "ready", record: { cover: true } })
			expect(deps.readRemote).toHaveBeenCalledTimes(2)
			expect(deps.readRemote).toHaveBeenLastCalledWith(expect.objectContaining({ uuid: "a" }), expect.any(String), {
				skipCover: false
			})
			expect(service.peekCoverUrl("a")).toBe("blob:1")
			// A cover refresh spent leaves the gain guard as it was, and the other way round.
			await service.request(track("a"), { refresh: true }).promise
			expect(deps.readRemote).toHaveBeenCalledTimes(2)
		})

		it("keeps the record unchanged when the gain re-read finds the file unparseable", async () => {
			const { service, deps } = makeService()

			putTrackTags("a", record({ title: "Kept", cover: true }))
			deps.readRemote.mockResolvedValue({ type: "unparseable" })

			expect(await service.request(track("a"), { refreshGain: true }).promise).toMatchObject({
				record: { title: "Kept", parsed: true }
			})
			expect(getTrackTags("a")).toEqual(record({ title: "Kept", cover: true }))
		})

		it("lets a cover refresh wait for a gain re-read in flight instead of joining it", async () => {
			const { service, deps } = makeService()
			const gate = Promise.withResolvers<AudioMetadataResult>()

			putTrackTags("a", record({ cover: true }))
			deps.readRemote.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(parsed(new Uint8Array([1])))

			const gain = service.request(track("a"), { refreshGain: true })
			const cover = service.request(track("a"), { refresh: true })

			await flush()
			gate.resolve(parsed(null))

			expect(await gain.promise).toMatchObject({ record: { gain: GAIN }, thumbnail: null })
			const covered = await cover.promise

			expect(covered.type === "ready" ? covered.thumbnail : null).toBeInstanceOf(Blob)
			expect(deps.readRemote.mock.calls.map(([, , options]) => options)).toEqual([{ skipCover: true }, { skipCover: false }])
		})
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

		const gate = Promise.withResolvers<AudioMetadataResult>()

		deps.readRemote.mockReturnValue(gate.promise)

		const running = service.request(track("a"))

		// Four run at once; "e" waits.
		for (const uuid of ["b", "c", "d", "e"]) {
			service.request(track(uuid))
		}

		await flush()
		putTrackTags("z", record())

		service.reset()

		expect(deps.cancelRead).toHaveBeenCalledTimes(4)
		expect(deps.revokeObjectUrl).toHaveBeenCalledWith("blob:1")
		expect(await running.promise).toEqual({ type: "unavailable" })
		expect(getTrackTags("z")).toBeUndefined()

		gate.resolve(parsed())
		await flush()

		expect(getTrackTags("a")).toBeUndefined()
		expect(deps.readRemote).toHaveBeenCalledTimes(4)
	})
})
