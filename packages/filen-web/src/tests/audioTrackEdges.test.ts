import { describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import type { AnyFile } from "@filen/sdk-rs"
import { RangeReadBudget } from "@/lib/media/rangeReads"
import { SourceReadError, type EdgeAnalysis } from "@/lib/media/remuxTypes"
import type { TrackEdges } from "@/features/audio/lib/smoothTransitions.types"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

vi.mock("@/lib/media/remuxClient", () => ({ holdRemuxWorker: vi.fn() }))
vi.mock("@/lib/media/playback/sources", () => ({ analysisRemuxSource: vi.fn() }))

const { TrackEdgesService } = await import("@/features/audio/lib/trackEdges")
const {
	EDGE_ANALYSIS_RANK,
	EDGE_ANALYZER_VERSION,
	edgesFromRecord,
	edgesMatchDuration,
	toEdgesRecord,
	trackEdgesKey,
	trackEdgesRecordSchema
} = await import("@/features/audio/lib/trackEdges.logic")
const { rowRank } = await import("@/features/drive/lib/thumbnails.logic")

import type { TrackEdgesDeps } from "@/features/audio/lib/trackEdges"
import type { TrackEdgesRecord } from "@/features/audio/lib/trackEdges.logic"

function track(uuid: string): QueueTrack {
	return { uuid, name: `${uuid}.mp3`, mime: "audio/mpeg", contentType: "audio/mpeg", file: { size: 1000n } as unknown as AnyFile }
}

const OK: TrackEdges = {
	status: "ok",
	durationSec: 200,
	inStartMs: 1450,
	outEndFromEndMs: 2950,
	fadeOutFromEndMs: 11_000,
	boundary: { headDb: -70, tailDb: -80 }
}

const FAILED: TrackEdges = {
	status: "failed",
	durationSec: null,
	inStartMs: null,
	outEndFromEndMs: null,
	fadeOutFromEndMs: null,
	boundary: null
}

// Past the gate's hold for a rank above 0, which is a timer.
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

function makeService(overrides: Partial<TrackEdgesDeps> = {}) {
	const kv = new Map<string, TrackEdgesRecord>()
	const deps = {
		readRecord: vi.fn<TrackEdgesDeps["readRecord"]>(uuid => Promise.resolve(kv.get(uuid) ?? null)),
		writeRecord: vi.fn<TrackEdgesDeps["writeRecord"]>((uuid, record) => {
			kv.set(uuid, record)
		}),
		deleteRecord: vi.fn<TrackEdgesDeps["deleteRecord"]>(uuid => {
			kv.delete(uuid)

			return Promise.resolve()
		}),
		analyze: vi.fn<TrackEdgesDeps["analyze"]>(() => Promise.resolve(OK)),
		reads: new RangeReadBudget(6, 2, 0),
		now: () => 7
	}

	return { service: new TrackEdgesService({ ...deps, ...overrides }), deps, kv }
}

function live(): AbortSignal {
	return new AbortController().signal
}

describe("trackEdges.logic", () => {
	it("versions a record with every analysis parameter and the byte budget", () => {
		expect(EDGE_ANALYZER_VERSION).toContain(String(16 * 1024 * 1024))
		expect(EDGE_ANALYZER_VERSION).toContain("-60")
		expect(trackEdgesKey("u")).toBe("audio.v1.edges.u")
	})

	it("round-trips a record, and reads one another analyzer version wrote as missing", () => {
		const record = toEdgesRecord(OK, 5)

		expect(trackEdgesRecordSchema(record)).toEqual(record)
		expect(edgesFromRecord(record)).toEqual(OK)
		expect(edgesFromRecord({ ...record, v: "0" })).toBeNull()
	})

	it("rejects a malformed record", () => {
		expect(trackEdgesRecordSchema({ ...toEdgesRecord(OK, 5), inStartMs: -5 })).toBeInstanceOf(type.errors)
		expect(trackEdgesRecordSchema({ ...toEdgesRecord(OK, 5), status: "maybe" })).toBeInstanceOf(type.errors)
	})

	it("matches the element's duration within 1.5 s", () => {
		expect(edgesMatchDuration(OK, 201_500)).toBe(true)
		expect(edgesMatchDuration(OK, 198_400)).toBe(false)
		expect(edgesMatchDuration(FAILED, 200_000)).toBe(false)
		expect(edgesMatchDuration(OK, Number.NaN)).toBe(false)
	})

	it("ranks behind tag reads (rank 0) and every thumbnail rank", () => {
		expect(EDGE_ANALYSIS_RANK).toBeGreaterThan(0)
		expect(EDGE_ANALYSIS_RANK).toBeGreaterThan(rowRank(0, { startIndex: 10_000, endIndex: 10_010 }))
		expect(EDGE_ANALYSIS_RANK).toBeGreaterThan(rowRank(100_000, { startIndex: 0, endIndex: 10 }))
	})
})

describe("TrackEdgesService", () => {
	it("answers from kv without analysing, then from memory without reading kv again", async () => {
		const { service, deps, kv } = makeService()

		kv.set("a", toEdgesRecord(OK, 1))

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(deps.readRecord).toHaveBeenCalledTimes(1)
		expect(deps.analyze).not.toHaveBeenCalled()
	})

	it("analyses a miss once, persisting and remembering the answer", async () => {
		const { service, deps, kv } = makeService()

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(kv.get("a")).toEqual(toEdgesRecord(OK, 7))
		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledTimes(1)
	})

	it("re-analyses a record an older analyzer wrote", async () => {
		const { service, deps, kv } = makeService()

		kv.set("a", { ...toEdgesRecord({ ...OK, inStartMs: 1 }, 1), v: "0" })

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledTimes(1)
		expect(kv.get("a")?.v).toBe(EDGE_ANALYZER_VERSION)
	})

	it("persists an undecodable file as failed, but not a read that failed", async () => {
		const { service, deps, kv } = makeService()

		deps.analyze.mockResolvedValueOnce(FAILED)

		expect(await service.get(track("a"), "direct", live())).toEqual(FAILED)
		expect(kv.get("a")?.status).toBe("failed")

		deps.analyze.mockRejectedValueOnce(new SourceReadError(new Error("network down")))

		expect(await service.get(track("b"), "direct", live())).toBeNull()
		expect(kv.has("b")).toBe(false)

		// The next request tries again.
		expect(await service.get(track("b"), "direct", live())).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledTimes(3)
	})

	it("records a budget-skipped analysis with its boundary levels", async () => {
		const skipped: EdgeAnalysis = { ...FAILED, status: "skipped", durationSec: 300, boundary: { headDb: -90, tailDb: -85 } }
		const { service, kv } = makeService({ analyze: () => Promise.resolve(skipped) })

		expect(await service.get(track("a"), "direct", live())).toEqual(skipped)
		expect(kv.get("a")).toMatchObject({ status: "skipped", boundary: { headDb: -90, tailDb: -85 } })
	})

	it("shares one analysis between concurrent requests", async () => {
		const gate = Promise.withResolvers<EdgeAnalysis>()
		const { service, deps } = makeService()

		deps.analyze.mockReturnValue(gate.promise)

		const first = service.get(track("a"), "direct", live())
		const second = service.get(track("a"), "direct", live())

		await flush()
		gate.resolve(OK)

		expect(await first).toEqual(OK)
		expect(await second).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledTimes(1)
	})

	it("resolves an aborted caller with null at once, and calls the analysis off once nobody wants it", async () => {
		const gate = Promise.withResolvers<EdgeAnalysis>()
		const { service, deps, kv } = makeService()
		const seen: { signal: AbortSignal | null } = { signal: null }

		deps.analyze.mockImplementation((_track, signal) => {
			seen.signal = signal

			return gate.promise
		})

		const one = new AbortController()
		const two = new AbortController()
		const first = service.get(track("a"), "direct", one.signal)
		const second = service.get(track("a"), "direct", two.signal)

		await flush()
		one.abort()

		expect(await first).toBeNull()
		expect(seen.signal?.aborted).toBe(false)

		two.abort()

		expect(await second).toBeNull()
		expect(seen.signal?.aborted).toBe(true)

		gate.resolve(OK)
		await flush()

		expect(kv.has("a")).toBe(false)
		expect(await service.get(track("a"), "direct", new AbortController().signal, { cachedOnly: true })).toBeNull()
	})

	it("starts a fresh analysis for a caller arriving after the last one gave up", async () => {
		const gate = Promise.withResolvers<EdgeAnalysis>()
		const { service, deps } = makeService()

		deps.analyze.mockReturnValueOnce(gate.promise)

		const controller = new AbortController()
		const abandoned = service.get(track("a"), "direct", controller.signal)

		await flush()
		controller.abort()
		await abandoned

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledTimes(2)
	})

	it("returns null for an already aborted signal without any I/O", async () => {
		const { service, deps } = makeService()
		const controller = new AbortController()

		controller.abort()

		expect(await service.get(track("a"), "direct", controller.signal)).toBeNull()
		expect(deps.readRecord).not.toHaveBeenCalled()
	})

	it("never analyses a transcoded or MediaSource route, nor on a cached-only request", async () => {
		const { service, deps, kv } = makeService()

		expect(await service.get(track("a"), "transcode", live())).toBeNull()
		expect(await service.get(track("a"), "session", live())).toBeNull()
		expect(await service.get(track("a"), "direct", live(), { cachedOnly: true })).toBeNull()
		expect(deps.analyze).not.toHaveBeenCalled()

		// What kv holds is still served on any route.
		kv.set("b", toEdgesRecord(OK, 1))

		expect(await service.get(track("b"), "transcode", live())).toEqual(OK)
	})

	it("keeps the 8 most recently used tracks in memory", async () => {
		const { service, deps } = makeService()

		for (let i = 0; i < 9; i++) {
			await service.get(track(`t${String(i)}`), "direct", live())
		}

		// t0 was the least recently used: gone from memory, back from kv.
		deps.readRecord.mockClear()
		await service.get(track("t1"), "direct", live())
		await service.get(track("t0"), "direct", live())

		expect(deps.readRecord.mock.calls.map(([uuid]) => uuid)).toEqual(["t0"])
		expect(deps.analyze).toHaveBeenCalledTimes(9)
	})

	it("never rejects, even when kv itself fails", async () => {
		const { service } = makeService({ readRecord: () => Promise.reject(new Error("kv down")) })

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
	})

	it("waits for its range-read permit behind tag and cover reads", async () => {
		const reads = new RangeReadBudget(1, 1, 0)
		const order: string[] = []
		const { service } = makeService({
			reads,
			analyze: () => {
				order.push("edges")

				return Promise.resolve(OK)
			}
		})

		await reads.acquire(() => 0)

		const edges = service.get(track("a"), "direct", live())

		await flush()

		const tags = reads.run(
			() => 0,
			() => {
				order.push("tags")

				return Promise.resolve()
			}
		)
		const cover = reads.run(
			() => rowRank(500, { startIndex: 0, endIndex: 10 }),
			() => {
				order.push("cover")

				return Promise.resolve()
			}
		)

		reads.release()
		await Promise.all([edges, tags, cover])

		expect(order).toEqual(["tags", "cover", "edges"])
	})

	it("forgets memory and calls analyses off on reset, writing nothing that settles after", async () => {
		const gate = Promise.withResolvers<EdgeAnalysis>()
		const { service, deps, kv } = makeService()

		kv.set("a", toEdgesRecord(OK, 1))
		await service.get(track("a"), "direct", live())
		deps.analyze.mockReturnValueOnce(gate.promise)

		const pending = service.get(track("b"), "direct", live())

		await flush()
		service.reset()
		gate.resolve(OK)

		expect(await pending).toBeNull()
		expect(kv.has("b")).toBe(false)

		deps.readRecord.mockClear()
		await service.get(track("a"), "direct", live())

		expect(deps.readRecord).toHaveBeenCalledOnce()
	})

	it("deletes rows and their memory", async () => {
		const { service, kv, deps } = makeService()

		await service.get(track("a"), "direct", live())
		await service.delete(["a"])

		expect(kv.has("a")).toBe(false)
		expect(await service.get(track("a"), "direct", live(), { cachedOnly: true })).toBeNull()
		expect(deps.deleteRecord).toHaveBeenCalledWith("a")
	})

	it("takes a permit per window, letting a cover read go between the windows", async () => {
		const reads = new RangeReadBudget(1, 1, 0)
		const order: string[] = []
		const coverQueued = Promise.withResolvers<undefined>()
		let cover: Promise<void> = Promise.resolve()
		const { service } = makeService({
			reads,
			analyze: async (_track, _signal, permits) => {
				await permits.acquire()
				order.push("head")
				// A cover asks for the only permit while the head window holds it.
				cover = reads.run(
					() => rowRank(500, { startIndex: 0, endIndex: 10 }),
					() => {
						order.push("cover")

						return Promise.resolve()
					}
				)
				coverQueued.resolve(undefined)
				await permits.release()
				await permits.acquire()
				order.push("tail")
				await permits.release()

				return OK
			}
		})

		expect(await service.get(track("a"), "direct", live())).toEqual(OK)
		await coverQueued.promise
		await cover

		expect(order).toEqual(["head", "cover", "tail"])

		// Every permit is back.
		await reads.run(
			() => 0,
			() => Promise.resolve()
		)
	})

	it("asks the worker only once the first window's permit is held", async () => {
		const reads = new RangeReadBudget(1, 1, 0)
		const { service, deps } = makeService({ reads })

		await reads.acquire(() => 0)

		const edges = service.get(track("a"), "direct", live())

		await flush()

		expect(deps.analyze).not.toHaveBeenCalled()

		reads.release()

		expect(await edges).toEqual(OK)
		expect(deps.analyze).toHaveBeenCalledOnce()
	})

	it("gives back every permit an analysis still holds when it ends, and one granted after", async () => {
		const reads = new RangeReadBudget(2, 2, 0)
		const late: Promise<unknown>[] = []
		const { service } = makeService({
			reads,
			analyze: async (_track, _signal, permits) => {
				await permits.acquire()
				// A worker that died mid-window: its permits never come back from it.
				await permits.acquire()
				late.push(permits.acquire().catch((error: unknown) => error))

				return Promise.reject(new SourceReadError(new Error("worker gone")))
			}
		})

		expect(await service.get(track("a"), "direct", live())).toBeNull()

		const [outcome] = await Promise.all(late)

		expect(outcome).toBeInstanceOf(DOMException)

		// Both permits are free again.
		await Promise.all([reads.acquire(() => 0), reads.acquire(() => 0)])
		reads.release()
		reads.release()
	})
})
