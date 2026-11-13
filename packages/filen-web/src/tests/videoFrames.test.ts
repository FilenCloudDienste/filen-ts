import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { type VideoProbe, BLOCK_BYTES } from "@filen/shared/videos"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: vi.fn(),
	kvSetJson: vi.fn(),
	kvKeys: vi.fn(),
	kvEntriesJson: vi.fn(),
	kvDelete: vi.fn()
}))
vi.mock("@/features/videos/workers/frame.worker.ts?worker", () => ({ default: vi.fn() }))

import { FrameGenerator, type FrameGeneratorDeps } from "@/features/videos/lib/frames"
import {
	FRAME_DWELL_MS,
	FRAME_FAILURE_LIMIT,
	FRAME_READS_PER_ITEM,
	FRAME_RECIPE_VERSION,
	FRAME_SESSION_MAX_BYTES,
	FRAME_SESSION_MAX_FRAMES,
	FrameSessionBudget,
	base64ToBytes,
	bytesToBase64,
	frameEligible,
	frameHintSchema,
	isSettledMiss,
	missIsSettled,
	usableKey,
	type FrameHint
} from "@/features/videos/lib/frames.logic"
import { RecordStore } from "@/features/videos/lib/recordStore.logic"
import type { FrameCaptureParams, FrameCaptureResult } from "@/features/videos/workers/frame.worker"
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
			rotation: 90,
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

describe("frame rules", () => {
	it("makes frames only where keyframes are indexed", () => {
		expect(frameEligible(probe())).toBe(true)
		expect(frameEligible(probe({ index: "none" }))).toBe(false)
		expect(frameEligible(probe({ container: "webm", index: "cues" }))).toBe(true)
		expect(frameEligible(probe({ container: "mp4", index: "moov" }))).toBe(true)
		expect(frameEligible(probe({ container: "mp4", index: null }))).toBe(true)
		expect(frameEligible(probe({ container: "mp4", index: "mfra" }))).toBe(true)
		expect(frameEligible(probe({ container: "mp4", index: "none" }))).toBe(false)
		expect(frameEligible(probe({ video: null }))).toBe(false)
		expect(frameEligible(null)).toBe(false)
	})

	it("spends at most eight reads a frame, forty frames and 64 MiB a session", () => {
		const budget = new FrameSessionBudget()

		expect(budget.readsAvailable()).toBe(FRAME_READS_PER_ITEM)

		for (let i = 0; i < FRAME_SESSION_MAX_FRAMES - 1; i++) {
			budget.spend(1)
		}

		expect(budget.readsAvailable()).toBe(FRAME_READS_PER_ITEM)
		budget.spend(1)
		expect(budget.readsAvailable()).toBe(0)

		const bytes = new FrameSessionBudget()

		bytes.spend(FRAME_SESSION_MAX_BYTES / BLOCK_BYTES - 3)
		expect(bytes.readsAvailable()).toBe(3)
		bytes.reset()
		expect(bytes.readsAvailable()).toBe(FRAME_READS_PER_ITEM)
	})

	it("keeps hints only for the current recipe", () => {
		const key = { offset: 1, size: 2, timeSec: 3, codec: "avc1.64001f", codedWidth: 4, codedHeight: 5, description: null }

		expect(usableKey({ recipe: FRAME_RECIPE_VERSION, key, miss: null, at: 0 })).toEqual(key)
		expect(usableKey({ recipe: FRAME_RECIPE_VERSION - 1, key, miss: null, at: 0 })).toBeNull()
		expect(isSettledMiss({ recipe: FRAME_RECIPE_VERSION, key: null, miss: "noIndex", at: 0 })).toBe(true)
		expect(isSettledMiss({ recipe: FRAME_RECIPE_VERSION - 1, key: null, miss: "noIndex", at: 0 })).toBe(false)
	})

	it("keeps only lasting verdicts: no index, an unsupported codec, a full budget spent", () => {
		expect(missIsSettled("noIndex", 8)).toBe(true)
		expect(missIsSettled("unsupported", 8)).toBe(true)
		expect(missIsSettled("budget", FRAME_READS_PER_ITEM)).toBe(true)
		expect(missIsSettled("budget", FRAME_READS_PER_ITEM - 1)).toBe(false)
		expect(missIsSettled("decode", 8)).toBe(false)
	})

	it("round-trips a decoder description through base64", () => {
		const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256)

		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
	})
})

const KEY = {
	offset: 1000,
	size: 2000,
	timeSec: 10.8,
	decoder: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: Uint8Array.from([1, 100, 0, 31]) }
}

function generator(results: FrameCaptureResult[]) {
	const { kv, rows } = memoryKv()
	const hints = new RecordStore<FrameHint>({
		prefix: "videos.v1.frame.",
		schema: frameHintSchema,
		maxRecords: 100,
		memoryRecords: 100,
		writesPerSweep: 1000,
		scope: "test",
		kv
	})
	const captures: FrameCaptureParams[] = []
	const deps: FrameGeneratorDeps = {
		openPort: vi.fn(() => Promise.resolve(new MessageChannel().port2)),
		cancel: vi.fn(),
		capture: vi.fn((params: FrameCaptureParams) => {
			captures.push(params)
			params.port.close()

			const fallback: FrameCaptureResult = { type: "miss", reason: "decode", reads: 1 }

			return Promise.resolve(results.shift() ?? fallback)
		}),
		hints,
		reads: { acquire: vi.fn(() => Promise.resolve()), release: vi.fn(), whenPlaybackIdle: vi.fn(() => Promise.resolve()) },
		sleep: vi.fn((_ms: number, signal: AbortSignal | undefined) =>
			signal?.aborted === true ? Promise.reject(new DOMException("aborted", "AbortError")) : Promise.resolve()
		),
		now: () => 7
	}

	return { frames: new FrameGenerator(deps), deps, captures, rows, hints }
}

const TARGET = { uuid: "video", file: { uuid: "video" } as unknown as AnyFile, size: 10 * BLOCK_BYTES }
const BOX = { width: 480, height: 270 }

function frame(reads: number): FrameCaptureResult {
	return { type: "frame", bytes: new Uint8Array([1]), width: 152, height: 270, dominant: [1, 2, 3], key: KEY, reads }
}

describe("FrameGenerator", () => {
	it("dwells, waits out playback, then captures once and leaves a hint for a one-read regeneration", async () => {
		const { frames, deps, captures, hints } = generator([frame(3), frame(1)])
		const made = await frames.generate({ target: TARGET, probe: probe(), box: BOX })

		expect(made).toEqual({ bytes: new Uint8Array([1]), width: 152, height: 270, dominant: [1, 2, 3] })
		expect(deps.sleep).toHaveBeenCalledWith(FRAME_DWELL_MS, expect.any(AbortSignal))
		expect(deps.reads.whenPlaybackIdle).toHaveBeenCalled()
		expect(captures[0]).toMatchObject({
			size: TARGET.size,
			maxReads: FRAME_READS_PER_ITEM,
			known: null,
			par: 1,
			rotation: 90,
			box: BOX
		})
		expect(hints.peek("video")).toEqual({
			recipe: FRAME_RECIPE_VERSION,
			key: {
				offset: 1000,
				size: 2000,
				timeSec: 10.8,
				codec: "avc1.64001f",
				codedWidth: 1280,
				codedHeight: 720,
				description: "AWQAHw=="
			},
			miss: null,
			at: 7
		})

		await frames.generate({ target: TARGET, probe: probe(), box: BOX })
		expect(captures[1]?.known).toEqual(KEY)
	})

	it("never reads for a file it cannot index, or for a requester gone during the dwell", async () => {
		const { frames, deps } = generator([])
		const gone = new AbortController()

		gone.abort()

		expect(await frames.generate({ target: TARGET, probe: probe({ index: "none" }), box: BOX })).toBeNull()
		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX, signal: gone.signal })).toBeNull()
		expect(deps.openPort).not.toHaveBeenCalled()
	})

	it("remembers a miss and never asks again for that file", async () => {
		const { frames, deps, rows } = generator([{ type: "miss", reason: "unsupported", reads: 2 }])

		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		expect(deps.capture).toHaveBeenCalledTimes(1)
		await Promise.resolve()
		expect(rows.get("videos.v1.frame.video")).toMatchObject({ key: null, miss: "unsupported" })
	})

	it("does not remember a budget miss the session's own budget caused", async () => {
		const { frames, hints, rows } = generator([
			frame(FRAME_SESSION_MAX_BYTES / BLOCK_BYTES - 2),
			{ type: "miss", reason: "budget", reads: 2 }
		])

		await frames.generate({ target: { ...TARGET, uuid: "first" }, probe: probe(), box: BOX })
		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		expect(hints.peek("video")).toBeNull()
		expect(rows.has("videos.v1.frame.video")).toBe(false)
	})

	it("stops once the session has made forty frames", async () => {
		const { frames, deps } = generator(Array.from({ length: 50 }, () => frame(1)))

		for (let i = 0; i < FRAME_SESSION_MAX_FRAMES; i++) {
			expect(await frames.generate({ target: { ...TARGET, uuid: `v${String(i)}` }, probe: probe(), box: BOX })).not.toBeNull()
		}

		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		expect(deps.capture).toHaveBeenCalledTimes(FRAME_SESSION_MAX_FRAMES)
	})

	it("releases the served port when a capture fails, and gives a file up after three failures", async () => {
		const { frames, deps } = generator([])

		vi.mocked(deps.capture).mockRejectedValue(new Error("worker died"))

		for (let i = 0; i < FRAME_FAILURE_LIMIT; i++) {
			expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		}

		expect(await frames.generate({ target: TARGET, probe: probe(), box: BOX })).toBeNull()
		expect(deps.capture).toHaveBeenCalledTimes(FRAME_FAILURE_LIMIT)
		expect(deps.cancel).toHaveBeenCalledTimes(FRAME_FAILURE_LIMIT)
	})

	it("counts a failed capture's whole read allowance against the session", async () => {
		const { frames, deps } = generator([])
		const attempts = FRAME_SESSION_MAX_BYTES / BLOCK_BYTES / FRAME_READS_PER_ITEM

		vi.mocked(deps.capture).mockRejectedValue(new Error("timed out"))

		for (let i = 0; i <= attempts; i++) {
			await frames.generate({ target: { ...TARGET, uuid: `v${String(i)}` }, probe: probe(), box: BOX })
		}

		expect(deps.capture).toHaveBeenCalledTimes(attempts)
	})

	it("keeps a good hint when its keyframe fails to decode this time", async () => {
		const { frames, hints } = generator([frame(2), { type: "miss", reason: "decode", reads: 1 }])

		await frames.generate({ target: TARGET, probe: probe(), box: BOX })

		const hint = hints.peek("video")

		expect(await frames.generate({ target: TARGET, probe: probe(), box: { width: 640, height: 360 } })).toBeNull()
		expect(hints.peek("video")).toEqual(hint)
	})

	it("shares one capture between requests for the same file and size", async () => {
		const { frames, deps } = generator([frame(1), frame(1)])
		const [a, b] = await Promise.all([
			frames.generate({ target: TARGET, probe: probe(), box: BOX }),
			frames.generate({ target: TARGET, probe: probe(), box: BOX })
		])

		expect(a).toBe(b)
		expect(deps.capture).toHaveBeenCalledTimes(1)
	})

	it("reads nothing for a requester that gave up while it waited for a read permit", async () => {
		const permit = Promise.withResolvers<undefined>()
		const waiting = Promise.withResolvers<undefined>()
		const { frames, deps } = generator([frame(1)])

		vi.mocked(deps.reads.acquire).mockImplementation(async () => {
			waiting.resolve(undefined)
			await permit.promise
		})

		const controller = new AbortController()
		const made = frames.generate({ target: TARGET, probe: probe(), box: BOX, signal: controller.signal })

		await waiting.promise
		controller.abort()
		permit.resolve(undefined)

		expect(await made).toBeNull()
		expect(deps.openPort).not.toHaveBeenCalled()
		expect(deps.reads.release).toHaveBeenCalledTimes(1)
	})
})
