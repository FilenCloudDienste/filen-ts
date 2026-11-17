import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { type } from "arktype"
import { PROBE_INDEXES, type ProbeTier, type VideoProbe } from "@filen/shared/videos"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: vi.fn(),
	kvSetJson: vi.fn(),
	kvKeys: vi.fn(),
	kvEntriesJson: vi.fn(),
	kvDelete: vi.fn()
}))

import { ProbeService, type ProbeServiceDeps } from "@/features/videos/lib/probeService"
import {
	PROBE_FINISH_WITHIN_BLOCKS,
	PROBE_DROP_GRACE_MS,
	PROBE_FAILURE_LIMIT,
	PROBE_KV_PREFIX,
	PROBE_RANK,
	PROBE_REVISION,
	PROBE_SESSION_SOFT_CAP,
	mayStartProbe,
	mergeProbe,
	probeRecordSchema,
	recordSatisfies,
	type ProbeRecord
} from "@/features/videos/lib/probeService.logic"
import { RecordStore } from "@/features/videos/lib/recordStore.logic"
import { RangeReadBudget } from "@/lib/media/rangeReads"
import { memoryKv } from "@/tests/support/memoryKv"

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
	return {
		v: 1,
		container: "mkv",
		durationSec: 60,
		index: "cues",
		video: {
			codec: "h264",
			fourcc: "avc1",
			codecString: "avc1.64001f",
			w: 1280,
			h: 720,
			par: 1,
			rotation: 0,
			bitDepth: 8,
			transfer: "sdr"
		},
		audio: [],
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false,
		...overrides
	}
}

// A probe as one stored before landscape covers were read.
function withoutLandscapeCover(read: VideoProbe): VideoProbe {
	const stored = { ...read }

	delete stored.coverLand

	return stored
}

const COVER = { offset: 100, size: 2000, mime: "image/jpeg" }
const COVER_LAND = { offset: 3000, size: 4000, mime: "image/png" }

describe("probe records", () => {
	it("folds tiers together: a cover read answers the card too, a card keeps a found cover, a full read replaces all", () => {
		const cover = mergeProbe(null, "cover", probe({ cover: COVER }), 1)

		expect(cover.tiers).toEqual({ card: true, full: false, cover: true })
		expect(recordSatisfies(cover, "card")).toBe(true)
		expect(cover.probe?.video?.codec).toBe("h264")

		const card = mergeProbe(cover, "card", probe(), 2)

		expect(card.probe?.cover).toEqual(COVER)
		expect(card.tiers).toEqual({ card: true, full: false, cover: true })

		const full = mergeProbe(card, "full", probe({ chapters: [{ t: 0, title: "Intro" }] }), 3)

		expect(full.tiers).toEqual({ card: true, full: true, cover: true })
		expect(full.probe?.cover).toBeNull()
	})

	it("keeps a landscape cover across a card read, and validates it", () => {
		const cover = mergeProbe(null, "cover", probe({ cover: COVER, coverLand: COVER_LAND }), 1)
		const card = mergeProbe(cover, "card", probe(), 2)

		expect(card.probe?.coverLand).toEqual(COVER_LAND)
		expect(probeRecordSchema(JSON.parse(JSON.stringify(card)))).toEqual(card)
	})

	it("says which requests a record answers; a file that is no container answers every one", () => {
		const card = mergeProbe(null, "card", probe(), 1)

		expect(recordSatisfies(card, "card")).toBe(true)
		expect(recordSatisfies(card, "cover")).toBe(false)
		expect(recordSatisfies(card, "full")).toBe(false)
		expect(recordSatisfies(mergeProbe(card, "full", probe(), 2), "cover")).toBe(true)
		expect(recordSatisfies(mergeProbe(null, "card", null, 1), "full")).toBe(true)
	})

	it("validates every index a walker records", () => {
		for (const index of PROBE_INDEXES) {
			const record = mergeProbe(null, "card", probe({ index }), 1)

			expect(probeRecordSchema(JSON.parse(JSON.stringify(record)))).toEqual(record)
		}

		expect(probeRecordSchema({ ...mergeProbe(null, "card", probe(), 1), probe: { ...probe(), index: "bogus" } })).toBeInstanceOf(
			type.errors
		)
	})

	it("persists no playability and validates what it stored", () => {
		const record = mergeProbe(null, "full", probe({ cover: COVER, chapters: [{ t: 0, end: 5, title: null, skipType: 1 }] }), 1)

		expect(JSON.stringify(record)).not.toMatch(/play/i)
		expect(probeRecordSchema(JSON.parse(JSON.stringify(record)))).toEqual(record)
		expect(JSON.stringify(record).length).toBeLessThan(600)
	})

	it("keeps answering with a record from before PROBE_REVISION, unless the probe now reads it otherwise", () => {
		const oldMkv = {
			probe: withoutLandscapeCover(probe({ container: "mkv", cover: COVER })),
			tiers: { card: true, full: false, cover: true },
			at: 1
		}
		const oldMp4 = {
			probe: withoutLandscapeCover(probe({ container: "mp4", cover: COVER })),
			tiers: { card: true, full: false, cover: true },
			at: 1
		}
		const oldNone = { probe: null, tiers: { card: true, full: true, cover: true }, at: 1 }

		expect(probeRecordSchema(JSON.parse(JSON.stringify(oldMkv)))).toEqual(oldMkv)
		expect(recordSatisfies(oldMkv, "card")).toBe(true)
		// A Matroska cover read that never looked for the landscape cover.
		expect(recordSatisfies(oldMkv, "cover")).toBe(false)
		expect(recordSatisfies(oldMp4, "cover")).toBe(true)
		expect(recordSatisfies(oldNone, "card", () => "clip.MTS")).toBe(false)
		expect(recordSatisfies(oldNone, "card", () => "film.avi")).toBe(true)
		expect(recordSatisfies(oldNone, "card")).toBe(true)
		expect(recordSatisfies(mergeProbe(null, "card", null, 2), "card", () => "clip.ts")).toBe(true)
	})

	it("folds a new read into an older record without keeping what it read differently", () => {
		const oldMkv = {
			probe: withoutLandscapeCover(probe({ container: "mkv", cover: COVER })),
			tiers: { card: true, full: false, cover: true },
			at: 1
		}
		const card = mergeProbe(oldMkv, "card", probe({ container: "mkv" }), 2)

		expect(card.rev).toBe(PROBE_REVISION)
		expect(card.tiers).toEqual({ card: true, full: false, cover: false })
		expect(card.probe?.cover).toEqual(COVER)

		const fromNone = mergeProbe({ probe: null, tiers: { card: true, full: true, cover: true }, at: 1 }, "card", probe(), 2)

		expect(fromNone.tiers).toEqual({ card: true, full: false, cover: false })
	})

	it("persists a transport stream's record", () => {
		const record = mergeProbe(null, "card", probe({ container: "ts", index: "none" }), 1)

		expect(probeRecordSchema(JSON.parse(JSON.stringify(record)))).toEqual(record)
	})

	it("lets only explicit requests start probes past the session's soft cap", () => {
		expect(mayStartProbe(PROBE_RANK.visible, PROBE_SESSION_SOFT_CAP - 1)).toBe(true)
		expect(mayStartProbe(PROBE_RANK.visible, PROBE_SESSION_SOFT_CAP)).toBe(false)
		expect(mayStartProbe(PROBE_RANK.explicit, PROBE_SESSION_SOFT_CAP + 50)).toBe(true)
	})
})

interface Call {
	uuid: string
	tier: ProbeTier
	token: string
	resolve: (probe: VideoProbe | null) => void
	reject: (error: unknown) => void
}

function harness(online = true) {
	const calls: Call[] = []
	const cancels: [string, number | undefined][] = []
	const { kv, rows } = memoryKv()
	const records = new RecordStore<ProbeRecord>({
		prefix: PROBE_KV_PREFIX,
		schema: probeRecordSchema,
		maxRecords: 100,
		memoryRecords: 100,
		writesPerSweep: 1000,
		scope: "test",
		kv
	})
	const reads = new RangeReadBudget(6, 2, 0)
	const deps: ProbeServiceDeps = {
		readProbe: (_file, uuid, tier, token) =>
			new Promise((resolve, reject) => {
				calls.push({ uuid, tier, token, resolve, reject })
			}),
		cancel: (token, keepPast) => {
			cancels.push([token, keepPast])

			const call = calls.find(item => item.token === token)

			if (keepPast === undefined || keepPast > 0) {
				call?.reject(new DOMException("aborted", "AbortError"))
			}
		},
		records,
		reads,
		isOnline: () => online,
		now: () => 1
	}

	return { service: new ProbeService(deps), calls, cancels, rows, records, reads }
}

function target(uuid: string): { uuid: string; file: AnyFile } {
	return { uuid, file: { uuid } as unknown as AnyFile }
}

function named(uuid: string, name: string): { uuid: string; file: AnyFile } {
	return { uuid, file: { uuid, size: 0n, meta: { type: "decoded", data: { name, mime: "" } } } as unknown as AnyFile }
}

// Runs due timers and the microtasks between them.
async function flush(ms = 0): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("ProbeService", () => {
	it("runs two probes at a time and the lowest rank next", async () => {
		const { service, calls } = harness()
		const ranks = { a: 1, b: 1, c: 3, d: 2 }

		for (const uuid of ["a", "b", "c", "d"] as const) {
			void service.request(target(uuid), "card", { rank: () => ranks[uuid] })
		}

		await flush(100)
		expect(calls.map(call => call.uuid)).toEqual(["a", "b"])

		calls[0]?.resolve(probe())
		await flush(100)
		expect(calls.map(call => call.uuid)).toEqual(["a", "b", "d"])
	})

	it("shares one probe between callers and answers later ones from the persisted record", async () => {
		const { service, calls, rows } = harness()
		const first = service.request(target("a"), "card")
		const second = service.request(target("a"), "card")

		await flush()
		expect(calls).toHaveLength(1)

		calls[0]?.resolve(probe())

		const [one, two] = await Promise.all([first, second])

		expect(one).toBe(two)
		expect(one?.tiers.card).toBe(true)
		await flush()
		expect(rows.has("videos.v1.probe.a")).toBe(true)

		await service.request(target("a"), "card")
		expect(calls).toHaveLength(1)
	})

	it("lets a card request join a full probe in flight", async () => {
		const { service, calls } = harness()
		const full = service.request(target("a"), "full")

		await flush()

		const card = service.request(target("a"), "card")

		await flush()
		expect(calls.map(call => call.tier)).toEqual(["full"])

		calls[0]?.resolve(probe())
		expect(await card).toBe(await full)
	})

	it("drops a queued probe nobody wants without reading, and keeps one wanted again within the grace", async () => {
		const { service, calls } = harness()
		void service.request(target("x"), "card")
		void service.request(target("y"), "card")

		const gone = new AbortController()
		const back = new AbortController()

		await flush()

		const dropped = service.request(target("a"), "card", { rank: () => 1, signal: gone.signal })
		const kept = service.request(target("b"), "card", { rank: () => 1, signal: back.signal })

		await flush()
		gone.abort()
		back.abort()
		await flush(PROBE_DROP_GRACE_MS / 2)
		void service.request(target("b"), "card", { rank: () => 1, signal: new AbortController().signal })
		await flush(PROBE_DROP_GRACE_MS)

		calls[0]?.resolve(probe())
		calls[1]?.resolve(probe())
		await flush(100)

		expect(await dropped).toBeNull()
		expect(calls.map(call => call.uuid)).toEqual(["x", "y", "b"])
		calls[2]?.resolve(probe())
		expect((await kept)?.tiers.card).toBe(true)
	})

	it("tells a running probe nobody wants to stop unless it is a block from done", async () => {
		const { service, calls, cancels } = harness()
		const controller = new AbortController()
		const running = service.request(target("a"), "card", { signal: controller.signal })

		await flush()
		expect(calls).toHaveLength(1)

		controller.abort()
		await flush(PROBE_DROP_GRACE_MS)

		expect(cancels).toEqual([[calls[0]?.token, PROBE_FINISH_WITHIN_BLOCKS]])
		expect(await running).toBeNull()
	})

	it("moves a queued card up when an explicit request for a deeper tier waits on it", async () => {
		const { service, calls } = harness()

		void service.request(target("x"), "card")
		void service.request(target("y"), "card")
		await flush()

		void service.request(target("a"), "card", { rank: () => PROBE_RANK.idle, signal: new AbortController().signal })
		void service.request(target("b"), "card", { rank: () => PROBE_RANK.nearViewport, signal: new AbortController().signal })
		await flush()

		const detail = service.request(target("a"), "full")

		await flush(100)
		calls[0]?.resolve(probe())
		await flush(100)

		expect(calls.map(call => `${call.uuid}:${call.tier}`)).toEqual(["x:card", "y:card", "a:card"])

		calls[2]?.resolve(probe())
		calls[1]?.resolve(probe())
		await flush(100)
		expect(calls.map(call => `${call.uuid}:${call.tier}`)).toContain("a:full")
		calls.find(call => call.tier === "full")?.resolve(probe())
		expect((await detail)?.tiers.full).toBe(true)
	})

	it("probes again a transport stream an older probe called no container: MPEG-TS was not read then", async () => {
		const { service, calls, rows } = harness()
		const old = { probe: null, tiers: { card: true, full: true, cover: true }, at: 1 }

		expect(PROBE_KV_PREFIX).toBe("videos.v1.probe.")
		rows.set("videos.v1.probe.a", old)
		rows.set("videos.v1.probe.b", old)

		const request = service.request(named("a", "clip.ts"), "card")
		const other = service.request(named("b", "film.avi"), "card")

		await flush()
		expect(calls.map(call => call.uuid)).toEqual(["a"])
		calls[0]?.resolve(probe({ container: "ts", index: "none" }))
		expect((await request)?.probe?.container).toBe("ts")
		expect(await other).toEqual(old)
	})

	it("starts nothing for a file another tab probed while this request queued", async () => {
		const { service, calls, rows } = harness()

		void service.request(target("x"), "card")
		void service.request(target("y"), "card")
		await flush()

		const queued = service.request(target("a"), "card")

		await flush()
		rows.set("videos.v1.probe.a", mergeProbe(null, "card", probe(), 9))
		calls[0]?.resolve(probe())

		expect((await queued)?.at).toBe(9)
		expect(calls.map(call => call.uuid)).toEqual(["x", "y"])
	})

	it("gives up on a file after three failed downloads until the connection returns", async () => {
		const { service, calls } = harness()

		for (let i = 0; i < PROBE_FAILURE_LIMIT; i++) {
			const request = service.request(target("a"), "card")

			await flush()
			calls[i]?.reject(new Error("download failed"))
			expect(await request).toBeNull()
		}

		expect(await service.request(target("a"), "card")).toBeNull()
		expect(calls).toHaveLength(PROBE_FAILURE_LIMIT)

		service.onReconnect()
		void service.request(target("a"), "card")
		await flush()
		expect(calls).toHaveLength(PROBE_FAILURE_LIMIT + 1)
	})

	it("starts nothing offline", async () => {
		const { service, calls } = harness(false)

		expect(await service.request(target("a"), "card")).toBeNull()
		expect(calls).toHaveLength(0)
	})

	it("past the soft cap, starts only explicit probes", async () => {
		const { service, calls } = harness()

		for (let i = 0; i < PROBE_SESSION_SOFT_CAP; i++) {
			const request = service.request(target(`f${String(i)}`), "card")

			await flush()
			calls[i]?.resolve(probe())
			await request
		}

		expect(service.startedCount).toBe(PROBE_SESSION_SOFT_CAP)
		const visible = service.request(target("visible"), "card", { rank: () => PROBE_RANK.visible })

		await flush(100)
		expect(await visible).toBeNull()

		const explicit = service.request(target("detail"), "full")

		await flush()
		calls.at(-1)?.resolve(probe())
		expect((await explicit)?.tiers.full).toBe(true)
	})

	it("holds one shared range-read permit per running probe", async () => {
		const { service, calls, reads } = harness()
		const order: string[] = []

		void service.request(target("a"), "card")
		await flush()
		void reads.acquire(() => 0).then(() => order.push("other"))
		await flush()

		// Six permits: the probe holds one, the other feature took one.
		expect(order).toEqual(["other"])
		expect(calls).toHaveLength(1)
	})

	it("aborts everything at reset and writes nothing back", async () => {
		const { service, calls, cancels, rows } = harness()
		const running = service.request(target("a"), "card")

		await flush()
		service.reset()
		calls[0]?.resolve(probe())

		expect(await running).toBeNull()
		expect(cancels.some(([, keepPast]) => keepPast === undefined)).toBe(true)
		await flush()
		expect(rows.size).toBe(0)
	})
})
