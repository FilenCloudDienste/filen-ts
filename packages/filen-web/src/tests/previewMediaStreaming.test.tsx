// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import type { AnyFile } from "@filen/sdk-rs"
import type { OpenPlaybackOptions, Playback } from "@/lib/media/playback/openPlayback"
import type { RemuxSessionOptions } from "@/lib/media/mseController"
import type { VideoProbe } from "@filen/shared/videos"
import "@/lib/i18n"

// Video and audio previews never buffer a whole file: with no service worker, and for a public link's
// visitor, they stream through MediaSource fed by the remux worker over an SDK range port (an
// unauthenticated one for a link).

const mocks = vi.hoisted(() => ({
	sdkApi: {
		openRangePort: vi.fn<(port: MessagePort, file: AnyFile, token: string) => Promise<void>>(() => Promise.resolve()),
		openLinkedRangePortAnon: vi.fn<(port: MessagePort, file: AnyFile, token: string) => Promise<void>>(() => Promise.resolve()),
		readLinkedVideoProbeAnon: vi.fn<() => Promise<VideoProbe | null>>(),
		downloadFileBytes: vi.fn(),
		downloadLinkedFileBytesAnon: vi.fn(),
		cancelPreviewDownload: vi.fn(() => Promise.resolve())
	},
	openRemuxSession: vi.fn<(options: RemuxSessionOptions) => Promise<unknown>>(),
	attach: vi.fn<(element: HTMLMediaElement) => Promise<void>>(() => Promise.resolve()),
	openPlayback:
		vi.fn<
			(
				video: HTMLVideoElement,
				file: AnyFile,
				probe: VideoProbe,
				selection: unknown,
				options: OpenPlaybackOptions
			) => Promise<Playback>
		>(),
	probeRequest: vi.fn(),
	previewStreamUrl:
		vi.fn<(file: AnyFile, name: string, contentType: string, id?: string, options?: { access?: string }) => Promise<string>>()
}))

// Whether a service worker controls the page.
const sw = vi.hoisted(() => ({ controlled: false }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: mocks.sdkApi }))
vi.mock("@/lib/media/mseController", () => ({ openRemuxSession: mocks.openRemuxSession, warmRemuxFile: vi.fn() }))
vi.mock("@/lib/media/playback/openPlayback", () => ({ openPlayback: mocks.openPlayback }))
vi.mock("@/features/videos/lib/probeService", () => ({ probeService: { request: mocks.probeRequest, onRecord: () => () => undefined } }))
vi.mock("@/lib/media/mediaVolume", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/media/mediaVolume")>()),
	warmMediaVolume: () => Promise.resolve()
}))
vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: () => sw.controlled,
	previewStreamUrl: mocks.previewStreamUrl,
	releasePreviewStream: vi.fn(),
	releasePreviewStreamSoon: vi.fn(),
	holdPreviewStream: vi.fn(),
	holdPreviewStreamAlive: () => () => undefined
}))

const { MediaViewer } = await import("@/features/preview/components/mediaViewer")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")
const { probeTransportStream } = await import("@/features/preview/lib/transportStreamProbe")
const { narrowToAnyFile } = await import("@/features/drive/lib/download")
const { attachFileKindVerdictStorage, fileKindVerdict } = await import("@/features/drive/lib/fileKindVerdicts")

// What reaches kv of the file-kind verdicts the previews' probes record.
const savedVerdicts: string[] = []

attachFileKindVerdictStorage({
	load: () => Promise.resolve([]),
	save: uuid => {
		savedVerdicts.push(uuid)

		return Promise.resolve()
	},
	remove: () => Promise.resolve()
})

const PROBE: VideoProbe = {
	v: 1,
	container: "mp4",
	durationSec: 10,
	index: "moov",
	video: { codec: "h264", fourcc: "avc1", codecString: "avc1.64001f", w: 640, h: 360, par: 1, rotation: 0, bitDepth: 8, transfer: "sdr" },
	audio: [],
	subs: [],
	chapters: [],
	cover: null,
	coverLand: null,
	partial: false
}

const PLAYBACK: Playback = {
	getSnapshot: () => ({
		status: "ready",
		decision: { path: "remux", reasons: [], audio: { mode: "none" } },
		selection: { audioIndex: -1, subtitle: "none" },
		failure: null,
		demotions: 0
	}),
	subscribe: () => () => undefined,
	selectAudio: () => Promise.resolve(),
	dispose: vi.fn()
}

mocks.openRemuxSession.mockResolvedValue({ attach: mocks.attach, dispose: vi.fn() })
mocks.openPlayback.mockResolvedValue(PLAYBACK)
mocks.probeRequest.mockResolvedValue({ probe: PROBE })
mocks.sdkApi.readLinkedVideoProbeAnon.mockResolvedValue(PROBE)

function anon({ children }: { children: ReactNode }) {
	return createElement(PreviewAccessModeProvider, { mode: "anon", linkScope: "scope", children })
}

function expectNoWholeFileRead(): void {
	expect(mocks.sdkApi.downloadFileBytes).not.toHaveBeenCalled()
	expect(mocks.sdkApi.downloadLinkedFileBytesAnon).not.toHaveBeenCalled()
}

beforeAll(() => {
	// jsdom has no media pipeline.
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
})

beforeEach(() => {
	// A browser with MediaSource unless a test takes it away.
	vi.stubGlobal("MediaSource", { isTypeSupported: () => true })
})

afterEach(() => {
	sw.controlled = false
	vi.unstubAllGlobals()
	cleanup()
	vi.clearAllMocks()
})

describe("audio preview without a service worker", () => {
	it("streams through MediaSource over the session's range port", async () => {
		render(createElement(MediaViewer, { item: linkedFileItem("track.mp3"), category: "audio", alt: "a" }))

		await waitFor(() => {
			expect(mocks.attach).toHaveBeenCalledOnce()
		})

		expect(mocks.attach.mock.calls[0]?.[0]).toBeInstanceOf(HTMLAudioElement)
		expect(mocks.sdkApi.openRangePort).toHaveBeenCalledOnce()
		expect(mocks.sdkApi.openLinkedRangePortAnon).not.toHaveBeenCalled()
		expect(mocks.openRemuxSession.mock.calls[0]?.[0]).toMatchObject({ startTime: 0 })
		expectNoWholeFileRead()
	})

	it("streams a public link's audio over an unauthenticated range port", async () => {
		render(createElement(MediaViewer, { item: linkedFileItem("track.flac"), category: "audio", alt: "a" }), { wrapper: anon })

		await waitFor(() => {
			expect(mocks.attach).toHaveBeenCalledOnce()
		})

		expect(mocks.sdkApi.openLinkedRangePortAnon).toHaveBeenCalledOnce()
		expect(mocks.sdkApi.openRangePort).not.toHaveBeenCalled()
		expectNoWholeFileRead()
	})

	// A shared browser's next signed-in user must not inherit what an anonymous visit read.
	it("keeps a public link's probe verdict in memory only", async () => {
		const item = linkedFileItem("talk.webm")
		const audioOnly: VideoProbe = {
			...PROBE,
			container: "webm",
			video: null,
			audio: [
				{
					id: 1,
					codec: "opus",
					codecString: "opus",
					ch: 2,
					rate: 48_000,
					lang: null,
					name: null,
					def: true,
					forced: false,
					commentary: false
				}
			]
		}

		mocks.sdkApi.readLinkedVideoProbeAnon.mockResolvedValueOnce(audioOnly)
		render(createElement(MediaViewer, { item, category: "video", alt: "v" }), { wrapper: anon })

		await waitFor(() => {
			expect(fileKindVerdict(item.data.uuid)).toBe("audio")
		})
		expect(savedVerdicts).not.toContain(item.data.uuid)
	})

	it("opens a public link's transport stream on the probe its gate read, reading the head once", async () => {
		const item = linkedFileItem("clip.ts", { size: 4_000_000n })
		const stream: VideoProbe = { ...PROBE, container: "ts", index: "none" }

		mocks.sdkApi.readLinkedVideoProbeAnon.mockResolvedValueOnce(stream)

		await expect(probeTransportStream(narrowToAnyFile(item), "anon", new AbortController().signal)).resolves.toBe(true)

		render(createElement(MediaViewer, { item, category: "video", alt: "v" }), { wrapper: anon })

		await waitFor(() => {
			expect(mocks.openPlayback).toHaveBeenCalledOnce()
		})

		expect(mocks.openPlayback.mock.calls[0]?.[2]).toBe(stream)
		expect(mocks.sdkApi.readLinkedVideoProbeAnon).toHaveBeenCalledOnce()
		expectNoWholeFileRead()
	})
})

describe("audio preview with a service worker", () => {
	it("plays a public link's audio natively through the service worker's route, no MediaSource", async () => {
		sw.controlled = true
		mocks.previewStreamUrl.mockResolvedValue("/sw/download/anon")
		render(
			createElement(MediaViewer, {
				item: linkedFileItem("track.aiff", { mime: { Decrypted: "audio/aiff" } }),
				category: "audio",
				alt: "a"
			}),
			{
				wrapper: anon
			}
		)

		await waitFor(() => {
			expect(mocks.previewStreamUrl).toHaveBeenCalledOnce()
		})

		expect(mocks.previewStreamUrl.mock.calls[0]?.[4]).toEqual({ access: "anon" })
		expect(mocks.openRemuxSession).not.toHaveBeenCalled()
		expectNoWholeFileRead()
	})

	it("says the browser cannot stream a file when there is neither a service worker nor MediaSource", async () => {
		const { screen } = await import("@testing-library/react")

		vi.stubGlobal("MediaSource", undefined)
		render(createElement(MediaViewer, { item: linkedFileItem("track.mp3"), category: "audio", alt: "a" }), { wrapper: anon })

		expect(await screen.findByText("This file can't be streamed here.")).toBeTruthy()
		expect(mocks.openRemuxSession).not.toHaveBeenCalled()
		expectNoWholeFileRead()
	})
})

describe("audio preview failures", () => {
	it("offers Retry for a lost source and goes on from where the element was", async () => {
		const { fireEvent, screen } = await import("@testing-library/react")

		mocks.openRemuxSession.mockClear()
		render(createElement(MediaViewer, { item: linkedFileItem("track.mp3"), category: "audio", alt: "a" }))

		await waitFor(() => {
			expect(mocks.attach).toHaveBeenCalledOnce()
		})

		const audio = mocks.attach.mock.calls[0]?.[0]

		if (audio === undefined) {
			throw new Error("no element")
		}

		Object.defineProperty(audio, "readyState", { value: 4, configurable: true })
		audio.currentTime = 42
		fireEvent.timeUpdate(audio)
		act(() => {
			mocks.openRemuxSession.mock.calls[0]?.[0].onFailure("source", "lost")
		})
		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		await waitFor(() => {
			expect(mocks.openRemuxSession).toHaveBeenCalledTimes(2)
		})
		expect(mocks.openRemuxSession.mock.calls[1]?.[0]).toMatchObject({ startTime: 42 })
	})
})

describe("video preview without a service worker", () => {
	it("probes once through the probe service and plays through the ladder with no direct rung", async () => {
		render(createElement(MediaViewer, { item: linkedFileItem("clip.mp4"), category: "video", alt: "v" }))

		await waitFor(() => {
			expect(mocks.openPlayback).toHaveBeenCalledOnce()
		})

		const options = mocks.openPlayback.mock.calls[0]?.[4]

		expect(mocks.probeRequest).toHaveBeenCalledOnce()
		expect(mocks.probeRequest.mock.calls[0]?.[1]).toBe("full")
		expect(options?.deps?.directAvailable?.()).toBe(false)

		await options?.deps?.remuxSource?.({ uuid: "u", size: 10n } as unknown as AnyFile).openPort()

		expect(mocks.sdkApi.openRangePort).toHaveBeenCalledOnce()
		expectNoWholeFileRead()
	})

	it("plays a public link's Matroska file over an unauthenticated probe and range port", async () => {
		render(createElement(MediaViewer, { item: linkedFileItem("movie.mkv"), category: "video", alt: "v" }), { wrapper: anon })

		await waitFor(() => {
			expect(mocks.openPlayback).toHaveBeenCalledOnce()
		})

		const options = mocks.openPlayback.mock.calls[0]?.[4]

		expect(mocks.sdkApi.readLinkedVideoProbeAnon).toHaveBeenCalledOnce()
		expect(mocks.probeRequest).not.toHaveBeenCalled()
		expect(options?.deps?.directAvailable?.()).toBe(false)

		await options?.deps?.remuxSource?.({ uuid: "u", size: 10n } as unknown as AnyFile).openPort()

		expect(mocks.sdkApi.openLinkedRangePortAnon).toHaveBeenCalledOnce()
		expect(mocks.sdkApi.openRangePort).not.toHaveBeenCalled()
		expectNoWholeFileRead()
	})

	it("opens a public link's transport stream on the probe its gate read, reading the head once", async () => {
		const item = linkedFileItem("clip.ts", { size: 4_000_000n })
		const stream: VideoProbe = { ...PROBE, container: "ts", index: "none" }

		mocks.sdkApi.readLinkedVideoProbeAnon.mockResolvedValueOnce(stream)

		await expect(probeTransportStream(narrowToAnyFile(item), "anon", new AbortController().signal)).resolves.toBe(true)

		render(createElement(MediaViewer, { item, category: "video", alt: "v" }), { wrapper: anon })

		await waitFor(() => {
			expect(mocks.openPlayback).toHaveBeenCalledOnce()
		})

		expect(mocks.openPlayback.mock.calls[0]?.[2]).toBe(stream)
		expect(mocks.sdkApi.readLinkedVideoProbeAnon).toHaveBeenCalledOnce()
		expectNoWholeFileRead()
	})
})
