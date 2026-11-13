import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { ladderQueries, type LadderProbe, type LadderSelection, type PlaybackCapabilities, type VideoProbe } from "@filen/shared/videos"
import type { RemuxSession, RemuxSessionOptions } from "@/lib/media/mseController"
import { demotionSignature, toLadderProbe, type LearnedDemotion } from "@/lib/media/playback/capabilities.logic"
import type { DirectSource } from "@/lib/media/playback/directSession"
import type { RemuxSource } from "@/lib/media/playback/remuxSession"
import { FakeVideo } from "@/tests/support/fakeVideo"

const { openRemuxSession } = vi.hoisted(() => ({ openRemuxSession: vi.fn<(options: RemuxSessionOptions) => Promise<RemuxSession>>() }))

vi.mock("@/lib/media/mseController", () => ({ openRemuxSession }))
vi.mock("@/lib/media/playback/sources", () => ({ directSource: vi.fn(), remuxSource: vi.fn() }))
vi.mock("@/features/preview/lib/previewStream", () => ({ isMediaStreamAvailable: () => true }))

const { openPlayback } = await import("@/lib/media/playback/openPlayback")

const FILE = { uuid: "u", size: 50_000_000n } as unknown as AnyFile

function videoProbe(container: VideoProbe["container"], audio: [string, string][] = [["aac", "mp4a.40.2"]]): VideoProbe {
	return {
		v: 1,
		container,
		durationSec: 100,
		index: container === "mp4" ? "moov" : "cues",
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
		audio: audio.map(([codec, codecString], index) => ({
			id: index + 2,
			codec: codec as "aac",
			codecString,
			ch: 2,
			rate: 48_000,
			lang: null,
			name: null,
			def: index === 0,
			forced: false,
			commentary: false
		})),
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}
}

// A browser that takes every query's MIME.
function everything(probe: LadderProbe, selection: LadderSelection): PlaybackCapabilities {
	const queries = ladderQueries(probe, selection)
	const yes = { supported: true, smooth: true }

	return {
		browser: "chrome",
		mediaSource: true,
		audioTracks: false,
		canPlayType: Object.fromEntries(queries.canPlayType.map(mime => [mime, "probably"])),
		isTypeSupported: Object.fromEntries(queries.isTypeSupported.map(mime => [mime, true])),
		decodingInfoFile: Object.fromEntries(queries.decodingInfoFile.map(mime => [mime, yes])),
		decodingInfoMediaSource: Object.fromEntries(queries.decodingInfoMediaSource.map(mime => [mime, yes])),
		audioEncoders: ["aac", "opus"]
	}
}

interface FakeRemux {
	options: RemuxSessionOptions
	selectAudio: ReturnType<typeof vi.fn>
	disposed: boolean
}

interface SetUpOptions {
	learned?: LearnedDemotion[]
	directAvailable?: boolean
	register?: (id: string) => Promise<string>
	selectAudio?: () => Promise<void>
}

function setUp(setUpOptions: SetUpOptions = {}) {
	const learned = setUpOptions.learned ?? []
	const video = new FakeVideo()
	const remuxes: FakeRemux[] = []
	const directIds: string[] = []
	const learn = vi.fn((_sig: string, _trigger: string, _file: string) => Promise.resolve())
	const remuxClose = vi.fn()
	let now = 0
	const direct: DirectSource = {
		register: id => {
			directIds.push(id)

			return setUpOptions.register?.(id) ?? Promise.resolve(`/sw/download/${id}`)
		},
		release: vi.fn(),
		holdAlive: () => () => undefined,
		status: () => Promise.resolve("present")
	}
	const remux: RemuxSource = { openPort: () => Promise.resolve(new MessageChannel().port2), close: remuxClose }

	openRemuxSession.mockImplementation(options => {
		const fake: FakeRemux = { options, selectAudio: vi.fn(setUpOptions.selectAudio ?? (() => Promise.resolve())), disposed: false }

		remuxes.push(fake)

		return Promise.resolve({
			info: {} as RemuxSession["info"],
			audioTracks: [],
			attach: () => {
				video.src = "blob:mse"

				return Promise.resolve()
			},
			play: () => Promise.resolve(),
			seek: () => undefined,
			selectAudio: fake.selectAudio,
			diagnostics: () => Promise.reject(new Error("unused")),
			dispose: () => {
				fake.disposed = true
			}
		} as RemuxSession)
	})

	const open = (probe: VideoProbe, options: { startTime?: number; autoplay?: boolean; selection?: LadderSelection } = {}) =>
		openPlayback(video.asElement(), FILE, probe, options.selection ?? { audioIndex: 0, subtitle: "none" }, {
			name: "movie",
			...(options.startTime === undefined ? {} : { startTime: options.startTime }),
			...(options.autoplay === undefined ? {} : { autoplay: options.autoplay }),
			deps: {
				capabilities: {
					capabilities: (probe, selection) => Promise.resolve(everything(probe, selection)),
					learned: () => Promise.resolve(new Map(learned.map(record => [record.sig, record]))),
					learn
				},
				environment: () => ({ browser: "chrome", frameCallback: true }),
				directAvailable: () => setUpOptions.directAvailable ?? true,
				directSource: () => direct,
				remuxSource: () => remux,
				capturePoster: () => Promise.resolve("blob:poster"),
				now: () => now
			}
		})

	return {
		video,
		remuxes,
		directIds,
		learn,
		remuxClose,
		open,
		advance: (ms: number) => {
			now += ms
		},
		// The element presents a frame (requestVideoFrameCallback).
		frame: () => {
			for (const callback of video.frameCallbacks.splice(0)) {
				callback()
			}
		}
	}
}

async function settle(): Promise<void> {
	for (let index = 0; index < 3; index++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

const revokeObjectURL = vi.fn()

const fakeDocument = Object.assign(new EventTarget(), { hidden: false })

beforeEach(() => {
	fakeDocument.hidden = false
	vi.stubGlobal("URL", { ...URL, revokeObjectURL, createObjectURL: vi.fn() })
	vi.stubGlobal("document", fakeDocument)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("openPlayback", () => {
	it("plays a natively playable file direct, and becomes ready on canplay", async () => {
		const { video, directIds, open } = setUp()
		const playback = await open(videoProbe("mp4"), { startTime: 12 })

		await settle()
		expect(playback.getSnapshot()).toMatchObject({ status: "opening", decision: { path: "direct" } })
		expect(video.src).toBe(`/sw/download/${directIds[0] ?? ""}`)

		video.loadMetadata()
		expect(video.currentTime).toBe(12)
		video.canPlay()
		expect(playback.getSnapshot().status).toBe("ready")
		playback.dispose()
	})

	it("demotes a failing rung: keeps the frame, goes on from the same position and play state, and learns once the next rung plays", async () => {
		const { video, remuxes, learn, open, frame } = setUp()
		const playback = await open(videoProbe("mp4"), { autoplay: true })
		const listener = vi.fn()

		playback.subscribe(listener)
		await settle()
		video.loadMetadata()
		video.canPlay()
		video.setAttribute("poster", "art.jpg")
		video.currentTime = 33
		video.fail(3)
		await settle()

		// Not yet: the file might be broken for every rung.
		expect(learn).not.toHaveBeenCalled()
		expect(playback.getSnapshot()).toMatchObject({
			status: "opening",
			decision: { path: "remux" },
			demotions: 1,
			failure: { trigger: "media-error" }
		})
		expect(video.poster).toBe("blob:poster")
		expect(remuxes[0]?.options).toMatchObject({ startTime: 33, audio: { trackId: 1, mode: "copy" }, idrOnlyStart: false })
		expect(video.src).toBe("blob:mse")
		// It was playing (autoplay): it plays on.
		expect(video.paused).toBe(false)

		video.canPlay()
		frame()
		expect(learn).toHaveBeenCalledWith(
			demotionSignature({ path: "direct", probe: toLadderProbe(videoProbe("mp4")), selection: { audioIndex: 0, subtitle: "none" } }),
			"media-error",
			expect.any(String)
		)
		expect(playback.getSnapshot().status).toBe("ready")
		// The element's own poster is back once the new rung shows a frame.
		expect(video.getAttribute("poster")).toBe("art.jpg")
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:poster")
		expect(listener).toHaveBeenCalled()
		playback.dispose()
	})

	it("keeps a paused player paused across a demotion", async () => {
		const { video, open } = setUp()
		const playback = await open(videoProbe("mp4"))

		await settle()
		video.loadMetadata()
		video.fail(3)
		await settle()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(playback.getSnapshot().decision.path).toBe("remux")
		expect(video.paused).toBe(true)
		expect(video.plays).toBe(0)
		playback.dispose()
	})

	it("starts below a rung this browser build is known to fail", async () => {
		const probe = videoProbe("mp4")
		const sig = demotionSignature({ path: "direct", probe: toLadderProbe(probe), selection: { audioIndex: 0, subtitle: "none" } })
		const { remuxes, open } = setUp({ learned: [{ sig, reason: "decode-stall", at: 0, files: ["a", "b"] }] })
		const playback = await open(probe)

		await settle()
		expect(playback.getSnapshot().decision.path).toBe("remux")
		expect(remuxes).toHaveLength(1)
		playback.dispose()
	})

	it("fails without demoting on a file problem, and forgets nothing about the browser", async () => {
		const { remuxes, learn, remuxClose, open } = setUp()
		const playback = await open(videoProbe("mkv"))

		await settle()
		remuxes[0]?.options.onFailure("keyframeIntervalTooLarge", "a 200 MB segment")
		await settle()

		expect(playback.getSnapshot()).toMatchObject({ status: "failed", failure: { trigger: "keyframe-interval" } })
		expect(learn).not.toHaveBeenCalled()
		expect(remuxes[0]?.disposed).toBe(true)
		expect(remuxClose).toHaveBeenCalled()
		playback.dispose()
	})

	it("reports a file nothing plays as unsupported, with the ladder's reasons", async () => {
		const { remuxes, directIds, open } = setUp()
		const probe = videoProbe("mkv")

		probe.video = null

		const playback = await open(probe)

		expect(playback.getSnapshot()).toMatchObject({ status: "unsupported", decision: { path: "unsupported", reasons: ["no-video"] } })
		expect(remuxes).toHaveLength(0)
		expect(directIds).toHaveLength(0)
	})

	it("switches audio inside the remux pipeline in place, and restarts where the pipeline changes", async () => {
		const { video, remuxes, open } = setUp()
		const playback = await open(
			videoProbe("mkv", [
				["aac", "mp4a.40.2"],
				["opus", "opus"]
			])
		)

		await settle()
		await playback.selectAudio(1)

		expect(remuxes).toHaveLength(1)
		expect(remuxes[0]?.selectAudio).toHaveBeenCalledWith(2, "copy")
		expect(playback.getSnapshot().selection.audioIndex).toBe(1)

		// Audio none: the session cannot drop its audio in place.
		video.loadMetadata()
		video.currentTime = 50
		await playback.selectAudio(-1)
		await settle()

		expect(remuxes).toHaveLength(2)
		expect(remuxes[1]?.options).toMatchObject({ startTime: 50, audio: { trackId: -1, mode: "none" } })
		expect(playback.getSnapshot()).toMatchObject({ decision: { path: "remux" }, demotions: 0 })
		playback.dispose()
	})

	it("ignores a failure from a session it has already replaced", async () => {
		const { video, remuxes, open } = setUp()
		const playback = await open(videoProbe("mp4"))

		await settle()
		video.loadMetadata()
		video.fail(3)
		await settle()
		expect(remuxes).toHaveLength(1)

		// The direct session is gone: an error on the element is the remux session's business now.
		video.fail(3)
		await settle()

		expect(playback.getSnapshot()).toMatchObject({ decision: { path: "remux" }, demotions: 1 })
		expect(remuxes).toHaveLength(1)
		playback.dispose()
		expect(remuxes[0]?.disposed).toBe(true)
	})

	it("learns nothing when several rungs fail the same file: the file is at fault", async () => {
		const { video, remuxes, learn, open, frame } = setUp()
		const playback = await open(videoProbe("mp4"), { autoplay: true })

		await settle()
		video.loadMetadata()
		video.fail(3)
		await settle()
		remuxes[0]?.options.onFailure("media", "decode")
		await settle()
		video.canPlay()
		frame()

		expect(playback.getSnapshot()).toMatchObject({ demotions: 2 })
		expect(learn).not.toHaveBeenCalled()
		playback.dispose()
	})

	it("learns nothing from a watchdog that ran while the tab was hidden", async () => {
		vi.useFakeTimers()

		const { video, learn, open, frame } = setUp()
		const playback = await open(videoProbe("mp4"), { autoplay: true })

		await vi.advanceTimersByTimeAsync(0)
		video.loadMetadata()
		video.canPlay()
		video.emit("playing")
		fakeDocument.hidden = true
		fakeDocument.dispatchEvent(new Event("visibilitychange"))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(playback.getSnapshot().demotions).toBe(0)

		fakeDocument.hidden = false
		fakeDocument.dispatchEvent(new Event("visibilitychange"))
		// No frame within the timeout once visible again: demoted, but not held against the browser.
		await vi.advanceTimersByTimeAsync(5_000)
		expect(playback.getSnapshot()).toMatchObject({ demotions: 1, failure: { trigger: "no-first-frame", learnable: false } })
		video.canPlay()
		frame()
		expect(learn).not.toHaveBeenCalled()
		playback.dispose()
	})

	it("never offers the direct rung without a service worker controlling the page", async () => {
		const { remuxes, directIds, open } = setUp({ directAvailable: false })
		const playback = await open(videoProbe("mp4"))

		await settle()
		expect(playback.getSnapshot().decision.path).toBe("remux")
		expect(directIds).toHaveLength(0)
		expect(remuxes).toHaveLength(1)
		playback.dispose()
	})

	it("moves on to remux when the direct stream cannot be registered, learning nothing", async () => {
		const { remuxes, learn, open, video, frame } = setUp({
			register: () => Promise.reject(new Error("service worker did not respond"))
		})
		const playback = await open(videoProbe("mp4"))

		await settle()
		expect(playback.getSnapshot()).toMatchObject({ decision: { path: "remux" }, failure: { trigger: "stream-unavailable" } })
		expect(remuxes).toHaveLength(1)
		video.canPlay()
		frame()
		expect(learn).not.toHaveBeenCalled()
		playback.dispose()
	})

	it("reopens a lost remux source at the same position once, and fails if it is lost again right away", async () => {
		const { video, remuxes, open, advance } = setUp()
		const playback = await open(videoProbe("mkv"), { autoplay: true })

		await settle()
		video.loadMetadata()
		video.currentTime = 1900
		remuxes[0]?.options.onFailure("source", "the file's byte source closed")
		await settle()

		expect(playback.getSnapshot()).toMatchObject({ status: "reconnecting", decision: { path: "remux" }, demotions: 0 })
		expect(remuxes).toHaveLength(2)
		expect(remuxes[1]?.options.startTime).toBe(1900)
		video.canPlay()
		expect(playback.getSnapshot().status).toBe("ready")

		advance(1000)
		remuxes[1]?.options.onFailure("source", "again")
		await settle()
		expect(playback.getSnapshot()).toMatchObject({ status: "failed", failure: { trigger: "network" } })
		playback.dispose()
	})

	it("keeps what failed during this playback when the audio changes", async () => {
		const { video, remuxes, directIds, open } = setUp()
		const playback = await open(
			videoProbe("mp4", [
				["aac", "mp4a.40.2"],
				["aac", "mp4a.40.2"]
			])
		)

		await settle()
		video.loadMetadata()
		video.fail(3)
		await settle()
		expect(playback.getSnapshot().decision.path).toBe("remux")

		await playback.selectAudio(1)
		await settle()

		// Direct failed for this file: the other track does not bring it back.
		expect(directIds).toHaveLength(1)
		expect(playback.getSnapshot()).toMatchObject({ decision: { path: "remux" }, selection: { audioIndex: 1 } })
		expect(remuxes.at(-1)?.selectAudio).toHaveBeenCalledWith(2, "copy")
		playback.dispose()
	})

	it("runs a failure after an audio switch already under way, on the switched track", async () => {
		const switching = Promise.withResolvers<undefined>()
		const { remuxes, open } = setUp({ selectAudio: () => switching.promise })
		const playback = await open(
			videoProbe("mkv", [
				["aac", "mp4a.40.2"],
				["opus", "opus"]
			])
		)

		await settle()

		const selected = playback.selectAudio(1)

		await settle()
		remuxes[0]?.options.onFailure("media", "decode")
		await settle()
		expect(remuxes).toHaveLength(1)

		switching.resolve(undefined)
		await selected
		await settle()

		expect(remuxes).toHaveLength(2)
		expect(remuxes[1]?.options.audio).toMatchObject({ trackId: 2 })
		expect(playback.getSnapshot()).toMatchObject({ selection: { audioIndex: 1 }, demotions: 1 })
		playback.dispose()
	})
})
