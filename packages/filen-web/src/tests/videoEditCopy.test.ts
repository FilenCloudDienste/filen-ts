import { describe, expect, it } from "vitest"
import { BufferTarget, EncodedPacketSink } from "mediabunny"
import { runExport, type EngineDeps } from "@/features/preview/videoEdit/worker/engine"
import { copyBounds, copyVideo, GopRule } from "@/features/preview/videoEdit/worker/copy"
import { ExportRefusedError } from "@/features/preview/videoEdit/worker/errors"
import { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"
import { appendOnlyTarget, NonMonotonicWriteError } from "@/features/preview/videoEdit/worker/sink"
import type { TimeRange, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import type { PlanContext } from "@/features/preview/videoEdit/lib/plan"
import { NO_WEBCODECS, recipeFor } from "@/tests/support/videoEditRecipe"
import {
	AUDIO_PACKET_SECONDS,
	audioIndexOf,
	FPS,
	frameOf,
	openInput,
	outputPackets,
	sourceFixture,
	sourceInfoOf,
	type FixtureOptions
} from "@/tests/support/videoEditFixtures"

// The copy path end to end on real (mediabunny-muxed) files: no encoder exists here, as on Firefox for Android.

const DEPS: EngineDeps = {
	createPipeline: () => {
		throw new Error("the copy path never renders")
	},
	createTimeStretch: () => {
		throw new Error("the copy path never stretches")
	},
	ios: false
}

async function exportOf(
	fixture: FixtureOptions,
	recipe: (duration: number) => VideoEditRecipe,
	options: { context?: PlanContext; info?: Partial<VideoSourceInfo>; deps?: Partial<EngineDeps> } = {}
): Promise<{ bytes: Uint8Array; info: VideoSourceInfo; source: Uint8Array }> {
	const source = await sourceFixture(fixture)
	const info = await sourceInfoOf(source, options.info)
	const target = new BufferTarget()

	await runExport({
		input: openInput(source),
		info,
		recipe: recipe(info.duration),
		caps: NO_WEBCODECS,
		context: options.context ?? { name: "clip.mp4" },
		target,
		signal: new AbortController().signal,
		fallbackCreationTime: null,
		deps: { ...DEPS, ...options.deps }
	})

	if (target.buffer === null) {
		throw new Error("no output")
	}

	return { bytes: new Uint8Array(target.buffer), info, source }
}

function inRanges(frame: number, ranges: readonly TimeRange[]): boolean {
	const time = frame / FPS

	return ranges.some(range => time >= range.start - 1e-6 && time < range.end - 1e-6)
}

const GOP_2S = 2 * FPS

describe("copy path", () => {
	it("copies a whole file packet for packet", async () => {
		const { bytes } = await exportOf({ seconds: 6, gop: GOP_2S, bframes: true, audio: true }, duration => recipeFor(duration))
		const { video, audio, input } = await outputPackets(bytes)

		expect(video.map(frameOf).sort((a, b) => a - b)).toEqual(Array.from({ length: 6 * FPS }, (_, index) => index))
		expect(video[0]?.type).toBe("key")
		expect(audio.length).toBeGreaterThan(0)
		expect((await input.getFormat()).name).toBe("MP4")
		expect(await input.computeDuration()).toBeCloseTo(6, 1)
	})

	it("concatenates many kept ranges without leaking a removed frame", async () => {
		const keep = [
			{ start: 0, end: 2 },
			{ start: 4, end: 6 },
			{ start: 8.5, end: 11 }
		]
		const { bytes } = await exportOf({ seconds: 12, gop: GOP_2S, bframes: true, audio: true }, duration =>
			recipeFor(duration, { keep })
		)
		const { video } = await outputPackets(bytes)
		const frames = video.map(frameOf)

		// 8.5 snapped to the key frame at 10: never earlier.
		const actual = [
			{ start: 0, end: 2 },
			{ start: 4, end: 6 },
			{ start: 10, end: 11 }
		]

		expect(frames.every(frame => inRanges(frame, actual))).toBe(true)
		expect(frames.filter(frame => frame >= 8.5 * FPS && frame < 10 * FPS)).toEqual([])
		expect(new Set(frames).size).toBe(frames.length)
		// Each range's first frame is a key frame, laid end to end on the output timeline.
		const keys = video.filter(packet => packet.type === "key").map(packet => [frameOf(packet), packet.timestamp])

		expect(keys).toEqual([
			[0, 0],
			[4 * FPS, expect.closeTo(2, 3)],
			[10 * FPS, expect.closeTo(4, 3)]
		])
	})

	it("ends a range at the last frame decodable before its cut (B-frames shrink it, never extend it)", async () => {
		// Decode order I0 P3 B1 B2 ... P24 B22 B23: a cut at frame 24 cannot keep 22 and 23 (they need P24).
		const { bytes } = await exportOf({ seconds: 4, gop: GOP_2S, bframes: true, audio: true }, () =>
			recipeFor(4, { keep: [{ start: 0, end: 1 }] })
		)
		const { video, audio } = await outputPackets(bytes)
		const frames = video.map(frameOf).sort((a, b) => a - b)

		expect(frames).toEqual(Array.from({ length: 22 }, (_, index) => index))

		// The audio stops with the video, not at the requested cut.
		const audioSeconds = audio.reduce((total, packet) => total + packet.duration, 0)

		expect(Math.abs(audioSeconds - 22 / FPS)).toBeLessThanOrEqual(AUDIO_PACKET_SECONDS / 2 + 1e-6)
	})

	it("drops an open GOP's leading pictures at a range's start", async () => {
		const { bytes } = await exportOf({ seconds: 6, gop: GOP_2S, bframes: false, openGop: true, audio: false }, () =>
			recipeFor(6, { keep: [{ start: 2, end: 6 }] })
		)
		const { video } = await outputPackets(bytes)
		const frames = video.map(frameOf)

		expect(Math.min(...frames)).toBe(GOP_2S)
		expect(frames).not.toContain(GOP_2S - 1)
		expect(frames).not.toContain(GOP_2S - 2)
		// The next GOP's leading pictures stay: they are inside the range.
		expect(frames).toContain(2 * GOP_2S - 1)
	})

	it("keeps the audio within half a packet of the video over many joins", async () => {
		const keep = Array.from({ length: 10 }, (_, index) => ({ start: index * 2, end: index * 2 + 0.37 + index * 0.11 }))
		const { bytes } = await exportOf({ seconds: 20, gop: FPS / 2, bframes: false, audio: true }, () => recipeFor(20, { keep }))
		const { video, audio } = await outputPackets(bytes)
		const videoEnd = Math.max(...video.map(packet => packet.timestamp + packet.duration))
		const audioEnd = audio.reduce((total, packet) => total + packet.duration, 0)

		expect(Math.abs(audioEnd - videoEnd)).toBeLessThanOrEqual(AUDIO_PACKET_SECONDS / 2 + 1e-6)

		// Every join: the audio laid where a range starts on the output comes from that range's source start, each within
		// a packet of where the video's range starts.
		const joins = audio.filter((packet, index) => index === 0 || audioIndexOf(packet) !== audioIndexOf(audio[index - 1] ?? packet) + 1)

		expect(joins.length).toBe(keep.length)

		keep.forEach((range, index) => {
			const join = joins[index]
			const videoStart = video.find(packet => frameOf(packet) === Math.round(range.start * FPS))

			expect(join).toBeDefined()
			expect(videoStart).toBeDefined()

			if (join !== undefined && videoStart !== undefined) {
				expect(Math.abs(audioIndexOf(join) * AUDIO_PACKET_SECONDS - range.start)).toBeLessThanOrEqual(AUDIO_PACKET_SECONDS)
				expect(Math.abs(join.timestamp - videoStart.timestamp)).toBeLessThanOrEqual(AUDIO_PACKET_SECONDS)
			}
		})
	})

	it("retimes the video for a speed-up without decoding it", async () => {
		const { bytes } = await exportOf({ seconds: 4, gop: GOP_2S, bframes: false, audio: false }, () => recipeFor(4, { speed: 2 }), {
			info: { videoCodec: "avc1.640033" }
		})
		const { video, input } = await outputPackets(bytes)

		expect(video.length).toBe(4 * FPS)
		expect(video[1]?.timestamp).toBeCloseTo(1 / FPS / 2, 3)
		expect(await input.computeDuration()).toBeCloseTo(2, 1)
	})

	it("writes rotation as metadata, adding the source's", async () => {
		const { bytes } = await exportOf(
			{ seconds: 2, gop: GOP_2S, bframes: false, audio: false, rotation: 90 },
			() => recipeFor(2, { rotate: 90 }),
			{
				info: { width: 720, height: 1280 }
			}
		)
		const track = await openInput(bytes).getPrimaryVideoTrack()

		expect(await track?.getRotation()).toBe(180)
	})

	it("writes QuickTime for a .mov saved in place", async () => {
		const { bytes } = await exportOf({ seconds: 2, gop: GOP_2S, bframes: false, audio: true, container: "mov" }, () => recipeFor(2), {
			context: { name: "clip.mov" },
			info: { container: "mov" }
		})
		const input = openInput(bytes)

		expect((await input.getFormat()).name).toBe("QuickTime File Format")
		expect((await outputPackets(bytes)).video.length).toBe(2 * FPS)
	})

	it("drops the audio when muted and copies only the kept track", async () => {
		const { bytes } = await exportOf({ seconds: 2, gop: GOP_2S, bframes: false, audio: true }, () =>
			recipeFor(2, { audio: { mute: true, gainDb: 0, keepTracks: "first" } })
		)

		expect(await openInput(bytes).getAudioTracks()).toEqual([])
	})

	it("keeps the creation time and drops location tags on request", async () => {
		const created = new Date("2021-06-01T10:00:00Z")
		const tags = { creationTime: created, title: "Holiday", raw: { "©xyz": "+52.5200+013.4050/", "©too": "camera" } }
		const kept = await exportOf({ seconds: 2, gop: GOP_2S, bframes: false, audio: false, tags }, () => recipeFor(2))
		const keptTags = await openInput(kept.bytes).getMetadataTags()

		expect(keptTags.creationTime?.getTime()).toBe(created.getTime())
		expect(keptTags.title).toBe("Holiday")
		expect(keptTags.raw?.["©xyz"]).toBe("+52.5200+013.4050/")

		const removed = await exportOf({ seconds: 2, gop: GOP_2S, bframes: false, audio: false, tags }, () =>
			recipeFor(2, { removeLocation: true })
		)
		const removedTags = await openInput(removed.bytes).getMetadataTags()

		expect(removedTags.raw?.["©xyz"]).toBeUndefined()
		expect(removedTags.creationTime?.getTime()).toBe(created.getTime())
	})

	it("names the drive's creation time when the file has none, never now", async () => {
		const source = await sourceFixture({ seconds: 2, gop: GOP_2S, bframes: false, audio: false, tags: { creationTime: null } })
		const info = await sourceInfoOf(source)
		const target = new BufferTarget()
		const fallback = Date.UTC(2019, 0, 2)

		await runExport({
			input: openInput(source),
			info,
			recipe: recipeFor(2),
			caps: NO_WEBCODECS,
			context: {},
			target,
			signal: new AbortController().signal,
			fallbackCreationTime: fallback,
			deps: DEPS
		})

		const tags = await openInput(new Uint8Array(target.buffer ?? new ArrayBuffer(0))).getMetadataTags()

		expect(tags.creationTime?.getTime()).toBe(fallback)
	})

	it("refuses a recipe the browser cannot do", async () => {
		const source = await sourceFixture({ seconds: 2, gop: GOP_2S, bframes: false, audio: false })
		const info = await sourceInfoOf(source)

		await expect(
			runExport({
				input: openInput(source),
				info,
				recipe: recipeFor(2, { flipH: true }),
				caps: NO_WEBCODECS,
				context: {},
				target: new BufferTarget(),
				signal: new AbortController().signal,
				fallbackCreationTime: null,
				deps: DEPS
			})
		).rejects.toMatchObject({ refusal: "unavailable" })
	})

	it("stops when cancelled", async () => {
		const source = await sourceFixture({ seconds: 4, gop: GOP_2S, bframes: false, audio: true })
		const info = await sourceInfoOf(source)
		const controller = new AbortController()

		controller.abort()

		await expect(
			runExport({
				input: openInput(source),
				info,
				recipe: recipeFor(4),
				caps: NO_WEBCODECS,
				context: {},
				target: new BufferTarget(),
				signal: controller.signal,
				fallbackCreationTime: null,
				deps: DEPS
			})
		).rejects.toMatchObject({ name: "ExportCancelledError" })
	})

	it("streams append-only through the save sink in whole chunks", async () => {
		const source = await sourceFixture({ seconds: 6, gop: GOP_2S, bframes: true, audio: true, padding: 20_000 })
		const info = await sourceInfoOf(source)
		const chunks: Uint8Array[] = []
		let closed = false
		const sink = appendOnlyTarget({
			write: chunk => {
				chunks.push(chunk.slice())

				return Promise.resolve()
			},
			close: () => {
				closed = true

				return Promise.resolve()
			}
		})

		await runExport({
			input: openInput(source),
			info,
			recipe: recipeFor(6, { keep: [{ start: 2, end: 6 }] }),
			caps: NO_WEBCODECS,
			context: {},
			target: sink.target,
			signal: new AbortController().signal,
			fallbackCreationTime: null,
			deps: DEPS
		})

		const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
		const bytes = new Uint8Array(total)
		let at = 0

		for (const chunk of chunks) {
			bytes.set(chunk, at)
			at += chunk.length
		}

		expect(closed).toBe(true)
		expect(sink.written()).toBe(total)
		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks.slice(0, -1).every(chunk => chunk.length === 1024 * 1024)).toBe(true)
		expect((await outputPackets(bytes)).video.length).toBe(4 * FPS)
		// The fragmented output names its duration (mvex/mehd) for players and the probe.
		expect(await openInput(bytes).computeDuration()).toBeCloseTo(4, 1)
	})
})

describe("copy path guards", () => {
	it("refuses a GOP larger than the iOS cap", async () => {
		const source = await sourceFixture({ seconds: 2, gop: GOP_2S, bframes: false, audio: false, padding: 10_000 })
		const track = await openInput(source).getPrimaryVideoTrack()

		if (track === null) {
			throw new Error("no track")
		}

		const sink = new EncodedPacketSink(track)
		const bounds = await copyBounds(sink, [{ start: 0, end: 2 }])
		const gate = new InterleaveGate(1)

		gate.addLane("video")

		await expect(
			copyVideo({
				sink,
				bounds,
				speed: 1,
				output: { add: () => Promise.resolve() } as never,
				decoderConfig: { codec: "avc1.64001f" },
				gate,
				lane: "video",
				signal: new AbortController().signal,
				gopByteCap: 100_000
			})
		).rejects.toBeInstanceOf(ExportRefusedError)
	})

	it("drops packets that break the GOP rule", () => {
		const rule = new GopRule()

		expect(rule.accepts(0, false)).toBe(false)
		expect(rule.accepts(0, true)).toBe(true)
		rule.record(0, true)
		rule.record(0.5, false)
		rule.record(1, true)
		// Presented before the previous GOP's last frame: undecodable in the output's order.
		expect(rule.accepts(0.4, false)).toBe(false)
		expect(rule.accepts(0.6, false)).toBe(true)
	})

	it("refuses a write that goes back", async () => {
		const sink = appendOnlyTarget({ write: () => Promise.resolve(), close: () => Promise.resolve() })
		// The target's own stream: reach it as the muxer would.
		const writable = (sink.target as unknown as { _writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }> })
			._writable
		const writer = writable.getWriter()

		await writer.write({ type: "write", data: new Uint8Array(4), position: 0 })
		await expect(writer.write({ type: "write", data: new Uint8Array(4), position: 2 })).rejects.toBeInstanceOf(NonMonotonicWriteError)
	})
})
