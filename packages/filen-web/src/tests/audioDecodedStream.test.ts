import { describe, expect, it, vi } from "vitest"
import type { PortStreamMeta } from "@/features/preview/lib/previewStream"

const { registerPortStream, openPcm } = vi.hoisted(() => ({
	registerPortStream: vi.fn(),
	openPcm: vi.fn()
}))

vi.mock("@/features/preview/lib/previewStream", () => ({ registerPortStream, releasePreviewStream: vi.fn() }))
vi.mock("@/lib/media/remuxClient", () => ({
	holdRemuxWorker: () =>
		Promise.resolve({
			remote: { openPcm, closePcm: vi.fn(() => Promise.resolve()) },
			dead: new Promise(() => undefined),
			release: vi.fn()
		})
}))
vi.mock("@/lib/media/playback/sources", () => ({
	remuxSource: () => ({ openPort: () => Promise.resolve(new MessageChannel().port2), close: vi.fn() }),
	linkedRemuxSource: vi.fn()
}))
const { openRemuxSession } = vi.hoisted(() => ({ openRemuxSession: vi.fn() }))

vi.mock("@/lib/media/mseController", () => ({ openRemuxSession }))

const { audioMediaSource, openDecodedAudioStream } = await import("@/lib/media/playback/audioStream")

describe("openDecodedAudioStream", () => {
	// Every window the service worker read ahead would be decoding the element has not asked for.
	it("registers its WAV stream for reading with no window ahead", async () => {
		const info = { id: 1, size: 44, contentType: "audio/wav", codec: "ac3", duration: 1, sampleRate: 48_000, channels: 2 }
		const metas: PortStreamMeta[] = []

		openPcm.mockResolvedValue(info)
		registerPortStream.mockImplementation(async (id: string, open: (port: MessagePort) => Promise<PortStreamMeta>) => {
			metas.push(await open(new MessageChannel().port1))

			return `/sw/download/${id}`
		})

		const stream = await openDecodedAudioStream({ file: { uuid: "f", size: 1000n } as never, access: "authed", id: "a1" })

		expect(stream.url).toBe("/sw/download/a1")
		expect(metas).toEqual([{ name: "audio.wav", size: 44, contentType: "audio/wav", readAhead: false }])
		stream.release()
	})
})

describe("audioMediaSource", () => {
	it.each([
		[new DOMException("remux worker ended", "AbortError"), []],
		[new Error("remux worker is gone (crashed)"), ["other"]]
	])("reports an open that fails with %s as %j", async (error, reported) => {
		const onFailure = vi.fn()

		openRemuxSession.mockRejectedValueOnce(error)

		const media = audioMediaSource({ file: { uuid: "f", size: 1000n } as never, access: "authed" })

		await media.attach({} as HTMLMediaElement, { onFailure })

		expect(onFailure.mock.calls.map(call => call[0] as unknown)).toEqual(reported)
		media.dispose()
	})
})
