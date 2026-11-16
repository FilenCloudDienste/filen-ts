import { afterEach, describe, expect, it, vi } from "vitest"
import type { RemuxSession, RemuxSessionOptions } from "@/lib/media/mseController"
import { IdrUnreachableError, SourceReadError, WarmGoneError } from "@/lib/media/remuxTypes"
import type { PlaybackFailure } from "@/lib/media/playback/types"
import { FakeVideo } from "@/tests/support/fakeVideo"

vi.mock("@/lib/media/mseController", () => ({ openRemuxSession: vi.fn() }))

const { openRemuxPlaybackSession, remuxOpenFailure, OPEN_PORT_TIMEOUT_MS, WARM_WAIT_MS } = await import("@/lib/media/playback/remuxSession")

afterEach(() => {
	vi.useRealTimers()
})

function setUp(
	attach: () => Promise<void> = () => Promise.resolve(),
	openPort: () => Promise<MessagePort> = () => Promise.resolve(new MessageChannel().port2)
) {
	const failures: PlaybackFailure[] = []
	const close = vi.fn()
	const opened: RemuxSessionOptions[] = []
	const remux = {
		attach: vi.fn(attach),
		selectAudio: vi.fn(() => Promise.resolve()),
		dispose: vi.fn()
	}
	const session = openRemuxPlaybackSession({
		path: "remux",
		source: { openPort, close },
		size: 1000,
		index: "cues",
		startTime: 7,
		audio: { index: 0, trackId: 2, mode: "copy" },
		idrOnlyStart: true,
		callbacks: { onFailure: failure => failures.push(failure), onReconnecting: () => undefined },
		open: options => {
			opened.push(options)

			return Promise.resolve(remux as unknown as RemuxSession)
		}
	})

	return { session, failures, close, opened, remux }
}

describe("remuxOpenFailure", () => {
	it.each([
		[new IdrUnreachableError(12), "open-gop-start"],
		[new SourceReadError(new Error("download failed")), "network"],
		[new DOMException("codecs", "NotSupportedError"), "media-error"],
		[new Error("remux worker is gone (terminated)"), "worker-error"]
	])("%s -> %s", (error, trigger) => {
		expect(remuxOpenFailure(error).trigger).toBe(trigger)
	})

	it("recognises errors by name, as they arrive from the worker", () => {
		const crossed = Object.assign(new Error("no IDR picture"), { name: "IdrUnreachableError" })

		expect(remuxOpenFailure(crossed).trigger).toBe("open-gop-start")
	})
})

describe("remux playback session", () => {
	it("opens the remux session with the plan's start, audio and IDR rule", async () => {
		const { session, opened, remux } = setUp()
		const video = new FakeVideo()

		await session.attach(video.asElement())

		expect(opened[0]).toMatchObject({
			size: 1000,
			index: "cues",
			startTime: 7,
			idrOnlyStart: true,
			audio: { trackId: 2, mode: "copy" }
		})
		expect(remux.attach).toHaveBeenCalledWith(video)
	})

	it("maps the controller's failures onto triggers, reporting only the first", async () => {
		const { session, opened, failures } = setUp()

		await session.attach(new FakeVideo().asElement())
		opened[0]?.onFailure("keyframeIntervalTooLarge", "a 200 MB segment")
		opened[0]?.onFailure("remux", "later")

		expect(failures).toEqual([{ trigger: "keyframe-interval", detail: "a 200 MB segment" }])
	})

	it("reports an attach that throws", async () => {
		const { session, failures } = setUp(() => Promise.reject(new IdrUnreachableError(40)))

		await session.attach(new FakeVideo().asElement())

		expect(failures[0]?.trigger).toBe("open-gop-start")
	})

	it("reports nothing when the remux worker is ended at sign-out while it opens", async () => {
		const { session, failures } = setUp(() => Promise.reject(new DOMException("remux worker ended", "AbortError")))

		await session.attach(new FakeVideo().asElement())

		expect(failures).toEqual([])
	})

	it("switches audio in place with the ladder's mode, but cannot drop audio", async () => {
		const { session, remux } = setUp()

		await session.attach(new FakeVideo().asElement())

		await expect(session.selectAudio({ index: 1, trackId: 3, mode: "transcode" })).resolves.toBe(true)
		expect(remux.selectAudio).toHaveBeenCalledWith(3, "transcode")
		await expect(session.selectAudio({ index: -1, trackId: -1, mode: "none" })).resolves.toBe(false)
	})

	it("disposes the controller and stops the file's reads", async () => {
		const { session, close, remux } = setUp()

		await session.attach(new FakeVideo().asElement())
		session.dispose()
		session.dispose()

		expect(remux.dispose).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
	})

	it("gives up on a byte source that never answers (its worker is gone) as a lost source", async () => {
		vi.useFakeTimers()

		const { session, failures, opened, close } = setUp(undefined, () => new Promise<MessagePort>(() => undefined))
		const attached = session.attach(new FakeVideo().asElement())

		await vi.advanceTimersByTimeAsync(OPEN_PORT_TIMEOUT_MS)
		await attached

		expect(failures[0]?.trigger).toBe("network")
		expect(opened).toHaveLength(0)
		// The source is let go, so a port that opens late frees its client at once.
		expect(close).toHaveBeenCalledOnce()
	})

	it("takes over a warmed file without opening another port", async () => {
		const openPort = vi.fn(() => Promise.resolve(new MessageChannel().port2))
		const close = vi.fn()
		const opened: RemuxSessionOptions[] = []
		const remux = { attach: vi.fn(() => Promise.resolve()), selectAudio: vi.fn(), dispose: vi.fn() }
		const session = openRemuxPlaybackSession({
			path: "remux",
			source: { openPort, close, warmKey: "warm-1" },
			size: 1000,
			index: null,
			startTime: 0,
			audio: null,
			idrOnlyStart: false,
			callbacks: { onFailure: () => undefined, onReconnecting: () => undefined },
			open: options => {
				opened.push(options)

				return Promise.resolve(remux as unknown as RemuxSession)
			}
		})

		await session.attach(new FakeVideo().asElement())

		expect(openPort).not.toHaveBeenCalled()
		expect(opened).toHaveLength(1)
		expect(opened[0]?.port).toBeUndefined()
		expect(opened[0]?.warmKey).toBe("warm-1")
		// The warm port is the source's: disposing stops its reads.
		session.dispose()
		expect(close).toHaveBeenCalledOnce()
	})

	it("takes over a warm only once it has reached the remux worker", async () => {
		const landed = Promise.withResolvers<undefined>()
		const openPort = vi.fn(() => Promise.resolve(new MessageChannel().port2))
		const opened: RemuxSessionOptions[] = []
		const remux = { attach: vi.fn(() => Promise.resolve()), selectAudio: vi.fn(), dispose: vi.fn() }
		const session = openRemuxPlaybackSession({
			path: "remux",
			source: { openPort, close: vi.fn(), warmKey: "warm-3", warmed: landed.promise },
			size: 1000,
			index: null,
			startTime: 0,
			audio: null,
			idrOnlyStart: false,
			callbacks: { onFailure: () => undefined, onReconnecting: () => undefined },
			open: options => {
				opened.push(options)

				return Promise.resolve(remux as unknown as RemuxSession)
			}
		})
		const attached = session.attach(new FakeVideo().asElement())

		await new Promise(resolve => setTimeout(resolve, 0))
		expect(opened).toHaveLength(0)
		landed.resolve(undefined)
		await attached

		expect(opened.map(options => [options.port, options.warmKey])).toEqual([[undefined, "warm-3"]])
		expect(openPort).not.toHaveBeenCalled()
	})

	it("goes ahead with the take-over when the warm never lands, and opens nothing once disposed meanwhile", async () => {
		vi.useFakeTimers()

		const opened: RemuxSessionOptions[] = []
		const make = () =>
			openRemuxPlaybackSession({
				path: "remux",
				source: { openPort: vi.fn(), close: vi.fn(), warmKey: "warm-4", warmed: new Promise<void>(() => undefined) },
				size: 1000,
				index: null,
				startTime: 0,
				audio: null,
				idrOnlyStart: false,
				callbacks: { onFailure: () => undefined, onReconnecting: () => undefined },
				open: options => {
					opened.push(options)

					return Promise.resolve({ attach: vi.fn(() => Promise.resolve()), dispose: vi.fn() } as unknown as RemuxSession)
				}
			})
		const waited = make()
		const waitedAttach = waited.attach(new FakeVideo().asElement())
		const disposed = make()
		const disposedAttach = disposed.attach(new FakeVideo().asElement())

		disposed.dispose()
		await vi.advanceTimersByTimeAsync(WARM_WAIT_MS)
		await Promise.all([waitedAttach, disposedAttach])

		expect(opened).toHaveLength(1)
		expect(opened[0]?.warmKey).toBe("warm-4")
	})

	it("fails a take-over at once as a lost source when the warm's port was never answered, opening no second port", async () => {
		vi.useFakeTimers()

		const openPort = vi.fn(() => new Promise<MessagePort>(() => undefined))
		const close = vi.fn()
		const opened: RemuxSessionOptions[] = []
		const failures: PlaybackFailure[] = []
		const session = openRemuxPlaybackSession({
			path: "remux",
			source: {
				openPort,
				close,
				warmKey: "warm-5",
				warmed: new Promise<void>(() => undefined),
				warmPort: new Promise<void>(() => undefined)
			},
			size: 1000,
			index: null,
			startTime: 0,
			audio: null,
			idrOnlyStart: false,
			callbacks: { onFailure: failure => failures.push(failure), onReconnecting: () => undefined },
			open: options => {
				opened.push(options)

				return Promise.reject(new WarmGoneError())
			}
		})
		const attached = session.attach(new FakeVideo().asElement())

		await vi.advanceTimersByTimeAsync(WARM_WAIT_MS)
		await attached

		expect(failures.map(failure => failure.trigger)).toEqual(["network"])
		expect(opened).toHaveLength(0)
		expect(openPort).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
		session.dispose()
		expect(close).toHaveBeenCalledOnce()
	})

	it("still takes over a warm whose port opened when the remux worker is slow to get it", async () => {
		vi.useFakeTimers()

		const opened: RemuxSessionOptions[] = []
		const failures: PlaybackFailure[] = []
		const remux = { attach: vi.fn(() => Promise.resolve()), selectAudio: vi.fn(), dispose: vi.fn() }
		const session = openRemuxPlaybackSession({
			path: "remux",
			source: {
				openPort: vi.fn(),
				close: vi.fn(),
				warmKey: "warm-6",
				warmed: new Promise<void>(() => undefined),
				warmPort: Promise.resolve()
			},
			size: 1000,
			index: null,
			startTime: 0,
			audio: null,
			idrOnlyStart: false,
			callbacks: { onFailure: failure => failures.push(failure), onReconnecting: () => undefined },
			open: options => {
				opened.push(options)

				return Promise.resolve(remux as unknown as RemuxSession)
			}
		})
		const attached = session.attach(new FakeVideo().asElement())

		await vi.advanceTimersByTimeAsync(WARM_WAIT_MS)
		await attached

		expect(opened.map(options => options.warmKey)).toEqual(["warm-6"])
		expect(failures).toEqual([])
	})

	it("opens a port of its own when the warmed file is gone", async () => {
		const port = new MessageChannel().port2
		const openPort = vi.fn(() => Promise.resolve(port))
		const opened: RemuxSessionOptions[] = []
		const failures: PlaybackFailure[] = []
		const remux = { attach: vi.fn(() => Promise.resolve()), selectAudio: vi.fn(), dispose: vi.fn() }
		const session = openRemuxPlaybackSession({
			path: "remux",
			source: { openPort, close: vi.fn(), warmKey: "warm-2" },
			size: 1000,
			index: null,
			startTime: 0,
			audio: null,
			idrOnlyStart: false,
			callbacks: { onFailure: failure => failures.push(failure), onReconnecting: () => undefined },
			open: options => {
				opened.push(options)

				// Crossed from the worker, by name.
				return options.port === undefined
					? Promise.reject(Object.assign(new Error("gone"), { name: new WarmGoneError().name }))
					: Promise.resolve(remux as unknown as RemuxSession)
			}
		})

		await session.attach(new FakeVideo().asElement())

		expect(openPort).toHaveBeenCalledOnce()
		expect(opened.map(options => options.port)).toEqual([undefined, port])
		expect(remux.attach).toHaveBeenCalledOnce()
		expect(failures).toEqual([])
	})
})
