import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { MAX_SUBTITLE_CUES, type LadderDecision, type MediaCodec, type VideoProbe } from "@filen/shared/videos"
import type { Playback, PlaybackSnapshot, openPlayback } from "@/lib/media/playback/openPlayback"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import { FakeVideo } from "@/tests/support/fakeVideo"

vi.mock("@/lib/media/mediaVolume", () => ({ warmMediaVolume: () => Promise.resolve() }))

const { PreviewVideo } = await import("@/features/preview/lib/previewVideo")
const { undecodedKinds } = await import("@/features/preview/lib/playbackGap")
const { STREAM_STALL_MS, STREAM_STALL_POLL_MS } = await import("@/lib/media/playback/directSession.logic")

// What the preview reads per route: a file the browser plays costs its stream registration and nothing
// else; the ladder costs one probe (cached per file by the probe service) and one playback.

const FILE = { uuid: "u", size: 10_000_000n } as unknown as AnyFile

// A playing element with the decode counters the gap check reads.
class DecodingVideo extends FakeVideo {
	public frames = 30
	public audioBytes = 4096
	public playable: (query: string) => boolean = query => query.includes("mp4a.40")

	public get webkitAudioDecodedByteCount(): number {
		return this.audioBytes
	}

	public getVideoPlaybackQuality(): { totalVideoFrames: number } {
		return { totalVideoFrames: this.frames }
	}

	public canPlayType(query: string): string {
		return this.playable(query) ? "probably" : ""
	}

	// `seconds` of playback in 0.25 s steps, as timeupdate reports them.
	public playFor(seconds: number): void {
		for (let elapsed = 0; elapsed < seconds; elapsed += 0.25) {
			this.currentTime += 0.25
			this.emit("timeupdate")
		}
	}
}

function probeOf(audio: MediaCodec[], container: VideoProbe["container"] = "mp4"): VideoProbe {
	return {
		v: 1,
		container,
		durationSec: 60,
		index: "moov",
		video: {
			codec: "h264",
			fourcc: "avc1",
			codecString: "avc1.64001f",
			w: 640,
			h: 360,
			par: 1,
			rotation: 0,
			bitDepth: 8,
			transfer: "sdr"
		},
		audio: audio.map((codec, index) => ({
			id: index + 2,
			codec,
			codecString: codec === "aac" ? "mp4a.40.2" : codec === "ac3" ? "ac-3" : null,
			ch: 2,
			rate: 48_000,
			lang: null,
			name: null,
			def: index === 0,
			forced: false,
			commentary: false
		})),
		subs: [{ id: 3, codecId: "S_TEXT/UTF8", lang: "en", name: null, def: false, forced: false, hi: false }],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}
}

function decision(path: LadderDecision["path"]): LadderDecision {
	return {
		path,
		reasons: path === "unsupported" ? ["remux-video-unsupported"] : [],
		audio: { mode: path === "video-only" ? "none" : "copy" }
	}
}

interface Harness {
	video: DecodingVideo
	controller: InstanceType<typeof PreviewVideo>
	registerDirect: ReturnType<typeof vi.fn<() => Promise<string>>>
	probe: ReturnType<typeof vi.fn>
	open: ReturnType<typeof vi.fn<typeof openPlayback>>
	playbackDeps: ReturnType<typeof vi.fn>
	textCues: () => ((cues: RemuxTextCue[]) => void) | undefined
	setPlayback: (snapshot: Partial<PlaybackSnapshot>) => void
	release: ReturnType<typeof vi.fn<(url: string) => void>>
	holdAlive: ReturnType<typeof vi.fn<() => () => void>>
	releaseAlive: ReturnType<typeof vi.fn<() => void>>
	playback: { dispose: ReturnType<typeof vi.fn>; selectAudio: ReturnType<typeof vi.fn> }
	gone: () => void
}

function setUp(options: {
	route: "direct" | "ladder"
	// The element's own audio track list (WebKit), when it has one.
	audioTracks?: { enabled: boolean; label: string; language: string }[]
	peek?: VideoProbe | null
	hidden?: () => boolean
	probe?: VideoProbe | null | "unavailable"
	path?: LadderDecision["path"]
	registerFails?: boolean
	startTime?: number
	status?: "present" | "missing" | "lost"
	// Registration resolves only when this settles.
	registration?: Promise<void>
	poster?: Promise<string | null>
}): Harness {
	const video = new DecodingVideo()

	if (options.audioTracks !== undefined) {
		Object.assign(video, { audioTracks: options.audioTracks })
	}

	const listeners = new Set<() => void>()
	let snapshot: PlaybackSnapshot = {
		status: "ready",
		decision: decision(options.path ?? "remux"),
		selection: { audioIndex: 0, subtitle: "none" },
		failure: null,
		demotions: 0
	}
	const playback = { dispose: vi.fn(), selectAudio: vi.fn((_index: number) => Promise.resolve()) }
	let onTextCues: ((cues: RemuxTextCue[]) => void) | undefined
	const fake: Playback = {
		getSnapshot: () => snapshot,
		subscribe: listener => {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		selectAudio: playback.selectAudio,
		dispose: playback.dispose
	}
	const release = vi.fn<(url: string) => void>()
	const releaseAlive = vi.fn<() => void>()
	const holdAlive = vi.fn<() => () => void>(() => releaseAlive)
	const registerDirect = vi.fn<() => Promise<string>>(() =>
		options.registerFails === true
			? Promise.reject(new Error("no worker"))
			: (options.registration ?? Promise.resolve()).then(() => "/__sw/stream/1")
	)
	const probeValue = options.probe === undefined ? probeOf(["aac"]) : options.probe
	const probe = vi.fn(() =>
		Promise.resolve(
			probeValue === "unavailable" ? { status: "unavailable" as const } : { status: "probed" as const, probe: probeValue }
		)
	)
	const open = vi.fn<typeof openPlayback>((_video, _file, _probe, _selection, openOptions) => {
		onTextCues = openOptions.onTextCues

		return Promise.resolve(fake)
	})
	const goneListeners: (() => void)[] = []
	const playbackDeps = vi.fn((allowDirect: boolean) => ({ directAvailable: () => allowDirect }))
	const controller = new PreviewVideo({
		file: FILE,
		name: "clip.mp4",
		route: options.route,
		startTime: options.startTime ?? 0,
		deps: {
			registerDirect,
			probe,
			playbackDeps,
			openPlayback: open,
			capturePoster: () => options.poster ?? Promise.resolve(null),
			status: () => Promise.resolve(options.status ?? "present"),
			release,
			holdAlive,
			onStreamGone: (_url: string, listener: () => void) => {
				goneListeners.push(listener)

				return () => undefined
			},
			now: () => Date.now(),
			hidden: options.hidden ?? (() => false),
			...(options.peek === undefined ? {} : { peek: () => options.peek ?? null })
		}
	})

	controller.open(video.asElement())

	return {
		video,
		controller,
		registerDirect,
		release,
		holdAlive,
		releaseAlive,
		probe,
		open,
		playbackDeps,
		playback,
		textCues: () => onTextCues,
		gone: () => {
			for (const listener of goneListeners) {
				listener()
			}
		},
		setPlayback: patch => {
			snapshot = { ...snapshot, ...patch }

			for (const listener of listeners) {
				listener()
			}
		}
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

afterEach(() => {
	vi.clearAllMocks()
})

describe("undecodedKinds", () => {
	it("flags a kind only where the element decoded none of it", () => {
		const video = new DecodingVideo()

		video.videoWidth = 640
		expect(undecodedKinds(video.asElement())).toEqual([])

		video.audioBytes = 0
		expect(undecodedKinds(video.asElement())).toEqual(["audio"])

		video.frames = 0
		expect(undecodedKinds(video.asElement())).toEqual(["video", "audio"])
	})
})

describe("PreviewVideo — a file the browser plays", () => {
	it("streams it from the service worker with no probe and no ladder", async () => {
		const harness = setUp({ route: "direct", startTime: 4 })

		await flush()

		expect(harness.registerDirect).toHaveBeenCalledOnce()
		expect(harness.video.src).toBe("/__sw/stream/1")

		harness.video.videoWidth = 640
		harness.video.loadMetadata()
		await flush()

		expect(harness.video.currentTime).toBe(4)
		expect(harness.video.plays).toBe(1)

		harness.video.playFor(3)
		await flush()

		expect(harness.probe).not.toHaveBeenCalled()
		expect(harness.open).not.toHaveBeenCalled()
		expect(harness.controller.getSnapshot()).toMatchObject({ status: "active", route: "direct" })
	})

	it("probes silence once and stays direct when the file has no sound to decode", async () => {
		const harness = setUp({ route: "direct", probe: probeOf([]) })

		await flush()
		harness.video.videoWidth = 640
		harness.video.audioBytes = 0
		harness.video.loadMetadata()
		harness.video.playFor(2)
		await flush()

		expect(harness.probe).toHaveBeenCalledOnce()
		expect(harness.open).not.toHaveBeenCalled()
		expect(harness.video.src).toBe("/__sw/stream/1")
	})

	// A public link's probe is cached nowhere else: the one the gap check read serves a later ladder open.
	it("opens the ladder on the probe its gap check read, when the stream later breaks", async () => {
		const harness = setUp({ route: "direct", probe: probeOf([]) })

		await flush()
		harness.video.videoWidth = 640
		harness.video.audioBytes = 0
		harness.video.loadMetadata()
		harness.video.playFor(2)
		await flush()

		expect(harness.probe).toHaveBeenCalledOnce()
		// Kept out of the snapshot: the direct start shows what it showed before.
		expect(harness.controller.getSnapshot().probe).toBeNull()

		harness.video.fail(2)
		await flush()

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.probe).toHaveBeenCalledOnce()
	})

	it("moves to the ladder, without the direct rung, when the browser cannot decode its audio", async () => {
		const harness = setUp({ route: "direct", probe: probeOf(["ac3"]), path: "remux+transcode" })

		await flush()
		harness.video.videoWidth = 640
		harness.video.audioBytes = 0
		harness.video.loadMetadata()
		void harness.video.play()
		harness.video.playFor(2)
		await flush()

		// The probe that confirmed the gap is the one the ladder plays from.
		expect(harness.probe).toHaveBeenCalledOnce()
		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(false)
		expect(harness.open.mock.calls[0]?.[4]).toMatchObject({ startTime: 2, autoplay: true })
		expect(harness.controller.getSnapshot()).toMatchObject({ route: "ladder", status: "active", silentCodec: null })
	})

	it("names the codec a picture-only rung plays without", async () => {
		const harness = setUp({ route: "direct", probe: probeOf(["ac3"]), path: "video-only" })

		await flush()
		harness.video.videoWidth = 640
		harness.video.audioBytes = 0
		harness.video.loadMetadata()
		harness.video.playFor(2)
		await flush()

		expect(harness.controller.getSnapshot().silentCodec).toBe("ac3")
	})

	it("moves to the ladder at the same position when the stream breaks", async () => {
		const harness = setUp({ route: "direct" })

		await flush()
		harness.video.loadMetadata()
		harness.video.currentTime = 12
		harness.video.fail(2)
		await flush()

		expect(harness.probe).toHaveBeenCalledOnce()
		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(false)
		expect(harness.open.mock.calls[0]?.[4]).toMatchObject({ startTime: 12 })
		expect(harness.video.loads).toBe(1)
	})

	it("opens the ladder where a seek made while the frame was kept moved the playhead", async () => {
		const poster = Promise.withResolvers<string | null>()
		const harness = setUp({ route: "direct", poster: poster.promise })

		await flush()
		harness.video.loadMetadata()
		harness.video.currentTime = 2
		harness.video.fail(2)
		await flush()
		harness.video.currentTime = 15
		poster.resolve(null)
		await flush()

		expect(harness.open.mock.calls[0]?.[4]).toMatchObject({ startTime: 15 })
	})

	it("moves to the ladder when the service worker cannot take the stream", async () => {
		const harness = setUp({ route: "direct", registerFails: true })

		await flush()

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(false)
	})
})

describe("PreviewVideo — the ladder", () => {
	it("opens a Matroska file with one probe and one playback", async () => {
		const harness = setUp({ route: "ladder", probe: probeOf(["aac"], "mkv"), startTime: 7 })

		await flush()

		expect(harness.registerDirect).not.toHaveBeenCalled()
		expect(harness.probe).toHaveBeenCalledOnce()
		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(true)
		expect(harness.open.mock.calls[0]?.[3]).toEqual({ audioIndex: 0, subtitle: "none" })
		expect(harness.open.mock.calls[0]?.[4]).toMatchObject({ startTime: 7, autoplay: true, name: "clip.mp4" })
	})

	it("reports the ladder's verdict when no rung plays the file", async () => {
		const harness = setUp({ route: "ladder", path: "unsupported" })

		await flush()
		harness.setPlayback({ status: "unsupported" })

		expect(harness.controller.getSnapshot()).toMatchObject({ status: "unsupported", decision: { path: "unsupported" } })
	})

	it("is unsupported without a playback for a file no probe reads", async () => {
		const harness = setUp({ route: "ladder", probe: null })

		await flush()

		expect(harness.open).not.toHaveBeenCalled()
		expect(harness.controller.getSnapshot()).toMatchObject({ status: "unsupported", probe: null })
	})

	it("fails when the probe cannot be had, and probes again on retry", async () => {
		const harness = setUp({ route: "ladder", probe: "unavailable" })

		await flush()

		expect(harness.controller.getSnapshot().status).toBe("failed")

		harness.controller.retry()
		await flush()

		expect(harness.probe).toHaveBeenCalledTimes(2)
	})

	it("keeps embedded cues once each across restarts and builds a store per track", async () => {
		const harness = setUp({ route: "ladder", probe: probeOf(["aac"], "mkv") })

		await flush()

		const cue: RemuxTextCue = { track: 3, start: 1, end: 2, text: "Hello", hint: 0 }
		// Starts with it: another speaker, kept beside it.
		const together: RemuxTextCue = { track: 3, start: 1, end: 3, text: "Hi", hint: 0 }

		harness.textCues()?.([cue, together])
		harness.textCues()?.([cue])

		const version = harness.controller.getSnapshot().embeddedVersion

		expect(version).toBe(1)
		expect(harness.controller.embeddedCues(3, version)?.texts).toEqual(["Hello", "Hi"])
		expect(harness.controller.embeddedCues(4, version)).toBeNull()
	})

	// The bytes are another user's when the file is shared or a public link.
	it("keeps embedded cues only for the tracks the probe offers, at most a cue store's worth per track", async () => {
		const harness = setUp({ route: "ladder", probe: probeOf(["aac"], "mkv") })

		await flush()

		const flood = Array.from({ length: MAX_SUBTITLE_CUES + 5 }, (_, index): RemuxTextCue => ({
			track: 3,
			start: index,
			end: index + 0.5,
			text: "x",
			hint: 0
		}))

		harness.textCues()?.(flood)
		harness.textCues()?.([{ track: 9, start: 1, end: 2, text: "stray", hint: 0 }])

		const version = harness.controller.getSnapshot().embeddedVersion

		expect(version).toBe(1)
		expect(harness.controller.embeddedCues(3, version)?.texts).toHaveLength(MAX_SUBTITLE_CUES)
		expect(harness.controller.embeddedCues(9, version)).toBeNull()
	})

	it("rebuilds a track's store only when that track got cues", async () => {
		const harness = setUp({ route: "ladder", probe: probeOf(["aac"], "mkv") })

		await flush()
		harness.textCues()?.([{ track: 3, start: 1, end: 2, text: "Hello", hint: 0 }])

		const store = harness.controller.embeddedCues(3, harness.controller.getSnapshot().embeddedVersion)

		expect(harness.controller.embeddedCues(3, harness.controller.getSnapshot().embeddedVersion + 1)).toBe(store)

		harness.textCues()?.([{ track: 3, start: 3, end: 4, text: "Again", hint: 0 }])

		expect(harness.controller.embeddedCues(3, harness.controller.getSnapshot().embeddedVersion)).not.toBe(store)
	})

	it("an embedded subtitle moves a direct start to the remux rung", async () => {
		const harness = setUp({ route: "direct", probe: probeOf(["aac"], "webm") })

		await flush()
		harness.controller.setSubtitle("embedded-text")
		await flush()

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.open.mock.calls[0]?.[3]).toEqual({ audioIndex: 0, subtitle: "embedded-text" })
	})

	it("disposes the playback and empties the element", async () => {
		const harness = setUp({ route: "ladder" })

		await flush()
		harness.controller.dispose()

		expect(harness.playback.dispose).toHaveBeenCalledOnce()
		expect(harness.video.loads).toBe(1)
	})
})

describe("PreviewVideo — a stalled service worker stream", () => {
	it("moves to the ladder when the stream no longer answers while the element waits on it", async () => {
		vi.useFakeTimers()

		const harness = setUp({ route: "direct", status: "lost" })

		await vi.advanceTimersByTimeAsync(0)
		harness.video.loadMetadata()
		harness.video.readyState = 1
		await harness.video.play()
		await vi.advanceTimersByTimeAsync(STREAM_STALL_MS + 2 * STREAM_STALL_POLL_MS)

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(false)
		vi.useRealTimers()
	})

	it("waits on a stream that still answers", async () => {
		vi.useFakeTimers()

		const harness = setUp({ route: "direct", status: "present" })

		await vi.advanceTimersByTimeAsync(0)
		harness.video.loadMetadata()
		harness.video.readyState = 1
		await harness.video.play()
		await vi.advanceTimersByTimeAsync(3 * STREAM_STALL_MS)

		expect(harness.open).not.toHaveBeenCalled()
		harness.controller.dispose()
		vi.useRealTimers()
	})
})

describe("PreviewVideo — the direct start's registration", () => {
	it("is handed back once, when the controller is disposed", async () => {
		const harness = setUp({ route: "direct" })

		await vi.waitFor(() => {
			expect(harness.registerDirect).toHaveBeenCalledOnce()
		})
		await Promise.resolve()
		harness.controller.dispose()
		harness.controller.dispose()

		expect(harness.release).toHaveBeenCalledExactlyOnceWith("/__sw/stream/1")
	})

	it("is handed back when playback moves to the ladder", async () => {
		const harness = setUp({ route: "direct" })

		await vi.waitFor(() => {
			expect(harness.registerDirect).toHaveBeenCalledOnce()
		})
		await Promise.resolve()
		harness.gone()

		await vi.waitFor(() => {
			expect(harness.release).toHaveBeenCalledExactlyOnceWith("/__sw/stream/1")
		})
		harness.controller.dispose()
		expect(harness.release).toHaveBeenCalledOnce()
	})

	it("is handed back when it lands after the controller was disposed", async () => {
		const registration = Promise.withResolvers<undefined>()
		const harness = setUp({ route: "direct", registration: registration.promise })

		harness.controller.dispose()
		expect(harness.release).not.toHaveBeenCalled()
		registration.resolve(undefined)

		await vi.waitFor(() => {
			expect(harness.release).toHaveBeenCalledExactlyOnceWith("/__sw/stream/1")
		})
	})
})

describe("PreviewVideo — the direct start keeps the worker alive", () => {
	it("from registration until the controller is disposed, paused included", async () => {
		const harness = setUp({ route: "direct" })

		await vi.waitFor(() => {
			expect(harness.holdAlive).toHaveBeenCalledOnce()
		})
		harness.video.emit("pause")
		expect(harness.releaseAlive).not.toHaveBeenCalled()

		harness.controller.dispose()
		harness.controller.dispose()
		expect(harness.releaseAlive).toHaveBeenCalledOnce()
	})

	it("until playback moves to the ladder, which holds the worker itself", async () => {
		const harness = setUp({ route: "direct" })

		await vi.waitFor(() => {
			expect(harness.holdAlive).toHaveBeenCalledOnce()
		})
		harness.gone()

		await vi.waitFor(() => {
			expect(harness.releaseAlive).toHaveBeenCalledOnce()
		})
		harness.controller.dispose()
		expect(harness.releaseAlive).toHaveBeenCalledOnce()
	})

	it("never, for a registration that lands after the controller was disposed or a ladder start", async () => {
		const registration = Promise.withResolvers<undefined>()
		const late = setUp({ route: "direct", registration: registration.promise })

		late.controller.dispose()
		registration.resolve(undefined)
		await vi.waitFor(() => {
			expect(late.release).toHaveBeenCalledOnce()
		})

		const ladder = setUp({ route: "ladder" })

		await flush()
		ladder.controller.dispose()

		expect(late.holdAlive).not.toHaveBeenCalled()
		expect(ladder.holdAlive).not.toHaveBeenCalled()
	})
})

describe("PreviewVideo — the worker reports its stream gone", () => {
	it("moves to the ladder at once, without waiting out a stall", async () => {
		const harness = setUp({ route: "direct" })

		await flush()
		harness.video.loadMetadata()
		harness.gone()
		await flush()

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.playbackDeps).toHaveBeenCalledWith(false)
	})
})

describe("PreviewVideo — audio tracks", () => {
	const twoTracks = (): { enabled: boolean; label: string; language: string }[] => [
		{ enabled: true, label: "Main", language: "en" },
		{ enabled: false, label: "Kommentar", language: "de" }
	]

	it("names the element's own audio tracks on a direct stream, and switches them in place", async () => {
		const audioTracks = twoTracks()
		const harness = setUp({ route: "direct", audioTracks })

		await flush()
		harness.video.loadMetadata()
		await flush()

		expect(harness.controller.getSnapshot()).toMatchObject({
			audioIndex: 0,
			nativeAudio: [
				{ label: "Main", language: "en" },
				{ label: "Kommentar", language: "de" }
			]
		})

		const loads = harness.video.loads

		harness.controller.selectAudio(1)
		await flush()

		expect(audioTracks.map(track => track.enabled)).toEqual([false, true])
		expect(harness.controller.getSnapshot()).toMatchObject({ route: "direct", audioIndex: 1 })
		expect(harness.open).not.toHaveBeenCalled()
		expect(harness.video.loads).toBe(loads)
	})

	it("moves a direct start to the ladder with the track asked for, where the element switches none itself", async () => {
		const harness = setUp({ route: "direct", probe: probeOf(["aac", "aac"]) })

		await flush()
		harness.controller.selectAudio(1)
		await flush()

		expect(harness.open).toHaveBeenCalledOnce()
		expect(harness.open.mock.calls[0]?.[3]).toEqual({ audioIndex: 1, subtitle: "none" })
	})

	it("switches through the ladder's playback once it plays", async () => {
		const harness = setUp({ route: "ladder", probe: probeOf(["aac", "ac3"]) })

		await flush()
		harness.controller.selectAudio(1)
		await flush()

		expect(harness.playback.selectAudio).toHaveBeenCalledWith(1)

		harness.setPlayback({ selection: { audioIndex: 1, subtitle: "none" } })

		expect(harness.controller.getSnapshot().audioIndex).toBe(1)
	})

	it("reads the probe once per open, on engagement, and not at all for a held one", async () => {
		const harness = setUp({ route: "direct" })

		await flush()
		expect(harness.probe).not.toHaveBeenCalled()

		harness.controller.ensureProbe()
		harness.controller.ensureProbe()
		await flush()
		harness.controller.ensureProbe()

		expect(harness.probe).toHaveBeenCalledOnce()
		expect(harness.controller.getSnapshot().probe).not.toBeNull()

		const held = setUp({ route: "direct", peek: probeOf(["aac", "aac"]) })

		held.controller.ensureProbe()
		await flush()

		expect(held.probe).not.toHaveBeenCalled()
		expect(held.controller.getSnapshot().probe?.audio).toHaveLength(2)
	})

	it("waits for a hidden page to be shown before probing", async () => {
		let hidden = true
		const page = new EventTarget()

		vi.stubGlobal("document", page)
		onTestFinished(() => {
			vi.unstubAllGlobals()
		})

		const harness = setUp({ route: "direct", hidden: () => hidden })

		await flush()
		harness.controller.ensureProbe()
		await flush()

		expect(harness.probe).not.toHaveBeenCalled()

		hidden = false
		page.dispatchEvent(new Event("visibilitychange"))
		await flush()

		expect(harness.probe).toHaveBeenCalledOnce()
	})
})
