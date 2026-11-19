import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import type {
	RemuxAudioStart,
	RemuxAudioStartParams,
	RemuxEvent,
	RemuxMediaInfo,
	RemuxSeekParams,
	RemuxSeekResult
} from "@/lib/media/remuxTypes"
import type { MseFailure, RemuxSessionOptions } from "@/lib/media/mseController"

// The MediaSource session against fake media elements, MediaSources and SourceBuffers that update on the
// next task, as browsers do.

type EventSink = (event: RemuxEvent) => Promise<void>

const worker = vi.hoisted(() => ({
	dead: null as unknown as PromiseWithResolvers<never>,
	onEvent: null as EventSink | null,
	open: null as unknown as Mock<(params: unknown, onEvent: EventSink) => Promise<{ id: number; info: RemuxMediaInfo }>>,
	seek: null as unknown as Mock<(id: number, params: RemuxSeekParams) => Promise<RemuxSeekResult>>,
	switchAudio: null as unknown as Mock<(id: number, params: RemuxAudioStartParams) => Promise<RemuxAudioStart>>
}))

vi.mock("@/lib/media/remuxClient", () => ({
	holdRemuxWorker: () =>
		Promise.resolve({
			remote: {
				open: (params: unknown, onEvent: EventSink) => worker.open(params, onEvent),
				seek: (id: number, params: RemuxSeekParams) => worker.seek(id, params),
				switchAudio: (id: number, params: RemuxAudioStartParams) => worker.switchAudio(id, params),
				canStartAt: () => Promise.resolve(true),
				stopAudio: () => Promise.resolve(),
				setHorizon: () => undefined,
				stats: () => null,
				close: () => Promise.resolve()
			},
			dead: worker.dead.promise,
			release: () => undefined
		})
}))

const { openRemuxSession } = await import("@/lib/media/mseController")
const { rangeReads } = await import("@/lib/media/rangeReads")

type Range = [number, number]

class FakeTimeRanges {
	private readonly ranges: Range[]

	public constructor(ranges: Range[]) {
		this.ranges = ranges.map(([start, end]) => [start, end])
	}

	public get length(): number {
		return this.ranges.length
	}

	public start(index: number): number {
		return this.ranges[index]?.[0] ?? 0
	}

	public end(index: number): number {
		return this.ranges[index]?.[1] ?? 0
	}
}

function nextTask(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await nextTask()
	}
}

class FakeSourceBuffer extends EventTarget {
	public updating = false
	public ranges: Range[] = []
	public quotaOnce = false
	// Every append throws QuotaExceededError, as a full SourceBuffer does.
	public quotaAlways = false
	public appendAttempts = 0
	// A removal stays in progress until finishRemove().
	public holdRemoves = false
	public readonly removes: Range[] = []
	private removing: (() => void) | null = null
	private readonly managed: boolean

	public constructor(managed: boolean) {
		super()
		this.managed = managed
	}

	public get buffered(): FakeTimeRanges {
		return new FakeTimeRanges(this.ranges)
	}

	public appendBuffer(): void {
		this.appendAttempts++

		// A runaway retry loop never yields to the timers a test waits on: end it with a non-quota error.
		if (this.appendAttempts > 100) {
			throw new Error("append retried without end")
		}

		if (this.quotaAlways) {
			throw new DOMException("full", "QuotaExceededError")
		}

		if (this.quotaOnce) {
			this.quotaOnce = false

			throw new DOMException("full", "QuotaExceededError")
		}

		this.updating = true
		setTimeout(() => {
			this.updating = false
			this.dispatchEvent(new Event("updateend"))
		}, 0)
	}

	public remove(start: number, end: number): void {
		this.removes.push([start, end])
		this.updating = true

		const done = () => {
			this.removing = null

			const removed: Range[] = []
			const kept: Range[] = []

			for (const [from, to] of this.ranges) {
				if (to <= start || from >= end) {
					kept.push([from, to])

					continue
				}

				removed.push([Math.max(from, start), Math.min(to, end)])

				if (from < start) {
					kept.push([from, start])
				}

				if (to > end) {
					kept.push([end, to])
				}
			}

			this.ranges = kept
			this.updating = false

			if (this.managed && removed.length > 0) {
				this.dispatchEvent(Object.assign(new Event("bufferedchange"), { removedRanges: new FakeTimeRanges(removed) }))
			}

			this.dispatchEvent(new Event("updateend"))
		}

		if (this.holdRemoves) {
			this.removing = done
		} else {
			setTimeout(done, 0)
		}
	}

	public finishRemove(): void {
		this.removing?.()
	}

	// As MSE specifies: a range removal in progress cannot be aborted.
	public abort(): void {
		if (this.removing !== null) {
			throw new DOMException("removal in progress", "InvalidStateError")
		}

		this.updating = false
	}

	public changeType(): void {
		// Same type throughout these tests.
	}

	// The browser dropping media on its own.
	public evict(start: number, end: number): void {
		this.ranges = this.ranges.filter(([from, to]) => to <= start || from >= end)
		this.dispatchEvent(Object.assign(new Event("bufferedchange"), { removedRanges: new FakeTimeRanges([[start, end]]) }))
	}
}

const mediaSources = new Map<string, FakeMediaSource>()

class FakeMediaSource extends EventTarget {
	public static managed = false
	public readyState = "closed"
	public duration = Number.NaN
	public readonly buffers: FakeSourceBuffer[] = []

	public static isTypeSupported(): boolean {
		return true
	}

	public addSourceBuffer(): FakeSourceBuffer {
		const buffer = new FakeSourceBuffer(FakeMediaSource.managed)

		this.buffers.push(buffer)

		return buffer
	}

	public endOfStream(): void {
		this.readyState = "ended"
	}
}

class FakeElement extends EventTarget {
	public readonly localName = "video"
	public readyState = 0
	public paused = true
	public seeking = false
	public ended = false
	public error = null
	public disableRemotePlayback = false
	private time = 0

	public get currentTime(): number {
		return this.time
	}

	public set currentTime(value: number) {
		this.time = value
		setTimeout(() => this.dispatchEvent(new Event("seeking")), 0)
	}

	public set src(url: string) {
		const mediaSource = mediaSources.get(url)

		this.readyState = 0

		if (mediaSource !== undefined) {
			setTimeout(() => {
				mediaSource.readyState = "open"
				mediaSource.dispatchEvent(new Event("sourceopen"))
			}, 0)
		}
	}

	// Playback moving on, without a seek.
	public advance(time: number): void {
		this.time = time
		this.dispatchEvent(new Event("timeupdate"))
	}

	public play(): Promise<void> {
		this.paused = false
		this.dispatchEvent(new Event("play"))
		this.dispatchEvent(new Event("playing"))

		return Promise.resolve()
	}

	public pause(): void {
		this.paused = true
		this.dispatchEvent(new Event("pause"))
	}

	public load(): void {
		this.dispatchEvent(new Event("emptied"))
	}

	public removeAttribute(): void {
		// Nothing to drop.
	}

	public loadMetadata(): void {
		this.readyState = 1
		this.dispatchEvent(new Event("loadedmetadata"))
	}

	public asElement(): HTMLMediaElement {
		return this as unknown as HTMLMediaElement
	}
}

const INFO: RemuxMediaInfo = {
	duration: 3600,
	bitrate: 4_000_000,
	index: null,
	seekScansFile: false,
	hasVideoTrack: true,
	video: { id: 1, codec: "avc1.640028", mime: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
	audio: [
		{ id: 2, codec: "aac", copyCodec: "mp4a.40.2", channels: 2, sampleRate: 48000, language: "en", name: null, isDefault: true },
		{ id: 3, codec: "aac", copyCodec: "mp4a.40.2", channels: 2, sampleRate: 48000, language: "de", name: null, isDefault: false }
	]
}
const AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"'

function lastMediaSource(): FakeMediaSource {
	const all = [...mediaSources.values()]
	const last = all.at(-1)

	if (last === undefined) {
		throw new Error("no MediaSource")
	}

	return last
}

function buffersOf(mediaSource: FakeMediaSource): { video: FakeSourceBuffer; audio: FakeSourceBuffer } {
	const [video, audio] = mediaSource.buffers

	if (video === undefined || audio === undefined) {
		throw new Error("no SourceBuffers")
	}

	return { video, audio }
}

async function open(options: Partial<RemuxSessionOptions> = {}) {
	const failures: [MseFailure, string][] = []
	const element = new FakeElement()
	const session = await openRemuxSession({
		...(options.warmKey === undefined ? { port: new MessageChannel().port2 } : {}),
		size: 1_000_000_000,
		audio: { trackId: 2, mode: "copy" },
		onFailure: (reason, detail) => {
			failures.push([reason, detail])
		},
		...options
	})

	await session.attach(element.asElement())

	return { session, element, failures }
}

function segment(kind: "video" | "audio", generation: number): RemuxEvent {
	return { type: "segment", kind, generation, bytes: new Uint8Array(64), init: false }
}

beforeEach(() => {
	mediaSources.clear()
	FakeMediaSource.managed = false
	vi.stubGlobal("MediaSource", FakeMediaSource)
	vi.stubGlobal("TimeRanges", FakeTimeRanges)
	vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 })
	vi.spyOn(URL, "createObjectURL").mockImplementation(object => {
		const url = `blob:fake/${String(mediaSources.size)}`

		mediaSources.set(url, object as unknown as FakeMediaSource)

		return url
	})
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
	worker.dead = Promise.withResolvers<never>()
	worker.onEvent = null
	worker.open = vi.fn((_params: unknown, onEvent: EventSink) => {
		worker.onEvent = onEvent

		return Promise.resolve({ id: 1, info: INFO })
	})
	worker.seek = vi.fn((_id: number, params: RemuxSeekParams) =>
		Promise.resolve({ video: { keyTime: params.time, clamped: false }, audio: { startTime: params.time, mime: AUDIO_MIME } })
	)
	worker.switchAudio = vi.fn((_id: number, params: RemuxAudioStartParams) =>
		Promise.resolve({ startTime: params.time, mime: AUDIO_MIME })
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("MediaSource remux session", () => {
	it("switches audio from the resume position while the element has no metadata yet", async () => {
		const { session } = await open({ startTime: 600 })

		await session.selectAudio(3, "copy")

		const params = worker.switchAudio.mock.calls[0]?.[1]

		expect(params?.time).toBeCloseTo(599.9)
		expect(params?.horizon).toBeGreaterThan(600)
		session.dispose()
	})

	it("keeps the resume position across a rebuild before metadata", async () => {
		const { session, element } = await open({ startTime: 600 })

		// Dropping audio needs a MediaSource without an audio SourceBuffer.
		await session.selectAudio(2, "none")
		await settle()

		expect(worker.seek.mock.calls.at(-1)?.[1].time).toBe(600)

		element.loadMetadata()

		expect(element.currentTime).toBe(600)
		session.dispose()
	})

	it("lets a seek during a quota eviction restart without aborting the removal", async () => {
		const { session, element, failures } = await open()
		const { video } = buffersOf(lastMediaSource())

		element.loadMetadata()
		element.currentTime = 20
		await settle()

		const generation = worker.seek.mock.calls.at(-1)?.[1].generation ?? 0

		video.ranges = [[0, 30]]
		video.quotaOnce = true
		video.holdRemoves = true
		await worker.onEvent?.(segment("video", generation))
		await settle()

		// The append hit the quota and its eviction behind the playhead is in progress.
		expect(video.removes).toEqual([[0, 18]])

		element.currentTime = 200
		await settle()
		video.finishRemove()
		await settle()

		expect(worker.seek).toHaveBeenCalledTimes(3)
		expect(failures).toEqual([])
		session.dispose()
	})

	it("holds each full SourceBuffer on its own wait without releasing the other", async () => {
		const { session, element, failures } = await open()
		const { video, audio } = buffersOf(lastMediaSource())

		element.loadMetadata()
		element.currentTime = 20
		await settle()

		const generation = worker.seek.mock.calls.at(-1)?.[1].generation ?? 0

		// Nothing behind the playhead to evict: each quota error shrinks the window and holds its track.
		video.ranges = [[20, 40]]
		audio.ranges = [[20, 40]]
		video.quotaAlways = true
		audio.quotaAlways = true
		await worker.onEvent?.(segment("video", generation))
		await settle()
		element.advance(21)
		await worker.onEvent?.(segment("audio", generation))
		await settle()

		expect(video.appendAttempts).toBe(1)
		expect(audio.appendAttempts).toBe(1)

		// Only the video wait has seen the playhead move on enough: video evicts and retries, audio stays held.
		element.advance(22.5)
		await settle()

		expect(video.removes).toEqual([[20, 20.5]])
		expect(video.appendAttempts).toBe(3)
		expect(audio.appendAttempts).toBe(1)
		expect(failures).toEqual([])
		session.dispose()
	})

	it("does not take its own removals on a ManagedMediaSource for the browser's eviction", async () => {
		FakeMediaSource.managed = true
		vi.stubGlobal("MediaSource", undefined)
		vi.stubGlobal("ManagedMediaSource", FakeMediaSource)

		const { session, element, failures } = await open()
		const { audio } = buffersOf(lastMediaSource())

		element.loadMetadata()
		await settle()
		audio.ranges = [[0, 40]]
		await session.selectAudio(3, "copy")
		await settle()

		expect(audio.removes).toEqual([[0, Number.POSITIVE_INFINITY]])
		expect(worker.seek).toHaveBeenCalledTimes(1)
		expect(failures).toEqual([])
		session.dispose()
	})

	it("refetches what a ManagedMediaSource evicts ahead within the refetch budget", async () => {
		FakeMediaSource.managed = true
		vi.stubGlobal("MediaSource", undefined)
		vi.stubGlobal("ManagedMediaSource", FakeMediaSource)

		const { session, element, failures } = await open()
		const { video } = buffersOf(lastMediaSource())

		element.loadMetadata()
		await settle()

		const aheads: number[] = [(await session.diagnostics()).ahead]

		for (let i = 0; i < 3; i++) {
			video.ranges = [[0, 40]]
			video.evict(20, 40)
			await settle()
			aheads.push((await session.diagnostics()).ahead)
		}

		expect(worker.seek).toHaveBeenCalledTimes(3)
		expect(aheads[1]).toBeLessThan(aheads[0] ?? 0)
		expect(failures.map(([reason]) => reason)).toEqual(["keyframeIntervalTooLarge"])
		session.dispose()
	})

	it("counts one eviction that reaches both SourceBuffers of a ManagedMediaSource once", async () => {
		FakeMediaSource.managed = true
		vi.stubGlobal("MediaSource", undefined)
		vi.stubGlobal("ManagedMediaSource", FakeMediaSource)

		const { session, element, failures } = await open()
		const { video, audio } = buffersOf(lastMediaSource())

		element.loadMetadata()
		await settle()

		const before = (await session.diagnostics()).ahead

		for (let i = 0; i < 2; i++) {
			video.ranges = [[0, 40]]
			audio.ranges = [[0, 40]]
			video.evict(20, 40)
			audio.evict(20, 40)
			await settle()
		}

		expect(worker.seek).toHaveBeenCalledTimes(3)
		expect((await session.diagnostics()).ahead).toBeCloseTo(before * 0.7 * 0.7)
		expect(failures).toEqual([])
		session.dispose()
	})

	it("fetches again from where a ManagedMediaSource cut the buffer, keeping what lies before it", async () => {
		FakeMediaSource.managed = true
		vi.stubGlobal("MediaSource", undefined)
		vi.stubGlobal("ManagedMediaSource", FakeMediaSource)

		const { session, element, failures } = await open()
		const { video, audio } = buffersOf(lastMediaSource())

		element.loadMetadata()
		await settle()

		const ahead = (await session.diagnostics()).ahead

		// Contiguous media, as two ranges only because this fake evicts whole ranges.
		video.ranges = [
			[0, 40],
			[40, 60]
		]
		audio.ranges = [
			[0, 40],
			[50, 60]
		]
		video.evict(40, 60)
		await settle()

		const params = worker.seek.mock.calls.at(-1)?.[1]

		expect(worker.seek).toHaveBeenCalledTimes(2)
		expect(params?.time).toBe(40)
		expect(params?.horizon).toBeCloseTo(Math.max(40, ahead * 0.7))
		// Nothing before the cut is dropped; what audio holds past it is fetched again with the rest.
		expect(video.removes).toEqual([])
		expect(audio.removes).toEqual([[50, 60]])
		expect(video.ranges).toEqual([[0, 40]])
		expect(failures).toEqual([])
		session.dispose()
	})

	it("restarts a file without an index at the playhead after an eviction", async () => {
		FakeMediaSource.managed = true
		vi.stubGlobal("MediaSource", undefined)
		vi.stubGlobal("ManagedMediaSource", FakeMediaSource)
		worker.open = vi.fn((_params: unknown, onEvent: EventSink) => {
			worker.onEvent = onEvent

			return Promise.resolve({ id: 1, info: { ...INFO, seekScansFile: true } })
		})

		const { session, element } = await open()
		const { video, audio } = buffersOf(lastMediaSource())

		element.loadMetadata()
		await settle()
		video.ranges = [
			[0, 40],
			[40, 60]
		]
		audio.ranges = [[0, 60]]
		video.evict(40, 60)
		await settle()

		expect(worker.seek.mock.calls.at(-1)?.[1].time).toBe(0)
		session.dispose()
	})

	it("claims range reads only while the element plays", async () => {
		const { session, element } = await open()

		expect(rangeReads.playing).toBe(false)
		await element.play()
		expect(rangeReads.playing).toBe(true)
		element.pause()
		expect(rangeReads.playing).toBe(false)
		await element.play()
		session.dispose()
		expect(rangeReads.playing).toBe(false)
	})

	it("stays quiet when the remux worker is ended at sign-out mid-play", async () => {
		const { session, element, failures } = await open()

		await element.play()
		worker.dead.reject(new DOMException("remux worker ended", "AbortError"))
		await settle()
		await session.selectAudio(3, "copy").catch(() => undefined)
		await settle()

		expect(failures).toEqual([])
		session.dispose()
	})

	it("reports a remux worker that dies mid-play", async () => {
		const { session, element, failures } = await open()

		await element.play()
		worker.dead.reject(new Error("remux worker is gone (crashed)"))
		await settle()

		expect(failures).toEqual([["remux", "remux worker is gone (crashed)"]])
		session.dispose()
	})

	it("takes over a warmed file without a port", async () => {
		const { session } = await open({ warmKey: "warm-1" })

		expect(worker.open.mock.calls[0]?.[0]).toEqual({ warmKey: "warm-1" })
		session.dispose()
	})
})
