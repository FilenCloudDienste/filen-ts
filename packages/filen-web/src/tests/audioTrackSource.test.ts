import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

const { releasePreviewStream, previewStreamUrl, openDecodedAudioStream, audioMediaSource, streaming, alive } = vi.hoisted(() => ({
	alive: { held: 0 },
	releasePreviewStream: vi.fn<(id: string) => void>(),
	previewStreamUrl: vi.fn((_file: unknown, _name: string, _type: string, id: string) => Promise.resolve(`/sw/download/${id}`)),
	openDecodedAudioStream: vi.fn(),
	audioMediaSource: vi.fn(),
	streaming: { value: true }
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: () => streaming.value,
	previewStreamUrl,
	releasePreviewStream,
	holdPreviewStreamAlive: () => {
		alive.held++

		return () => {
			alive.held--
		}
	}
}))
vi.mock("@/lib/media/playback/audioStream", () => ({ openDecodedAudioStream, audioMediaSource }))

import { resolveTrackSource } from "@/features/audio/lib/bytes"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import { audioDemotions } from "@/lib/media/audioRoute.logic"
import { AUDIO_UNSUPPORTED_ERROR } from "@/lib/media/remuxTypes"
import { asErrorDTO } from "@/lib/sdk/errors"
import { MEDIA_FORMAT_UNSUPPORTED } from "@/lib/media/mediaFailure"

function track(name: string, contentType: string | null = "audio/mpeg"): QueueTrack {
	return { uuid: name, name, mime: contentType ?? "", contentType, file: { size: 1024n } as unknown as AnyFile }
}

function decoded(url: string) {
	return {
		url,
		info: { size: 44, contentType: "audio/wav", codec: "ac3", duration: 1, sampleRate: 48_000, channels: 2 },
		release: vi.fn()
	}
}

afterEach(() => {
	alive.held = 0
	vi.clearAllMocks()
	audioDemotions.clear()
	streaming.value = true
})

describe("resolveTrackSource", () => {
	it("streams a file the browser plays as it is, and demotes it to its decoded stream on a format failure", async () => {
		const source = await resolveTrackSource(track("a.mp3"), new AbortController().signal)

		expect(source.media).toEqual({ kind: "url", url: expect.stringMatching(/^\/sw\/download\//) as unknown })
		expect(openDecodedAudioStream).not.toHaveBeenCalled()

		// The service worker is kept awake for as long as the stream is held.
		expect(alive.held).toBe(1)

		source.demote?.()
		source.release()
		expect(releasePreviewStream).toHaveBeenCalledOnce()
		expect(alive.held).toBe(0)

		openDecodedAudioStream.mockResolvedValue(decoded("/sw/download/wav"))

		const again = await resolveTrackSource(track("a.mp3"), new AbortController().signal)

		expect(again.media).toEqual({ kind: "url", url: "/sw/download/wav" })
		expect(again.demote).toBeUndefined()
		expect(await again.classify(4)).toBe("other")
	})

	it("decodes what no browser plays as it is, and a file without a type to serve it as", async () => {
		const stream = decoded("/sw/download/wav")

		openDecodedAudioStream.mockResolvedValue(stream)

		for (const name of ["film.mka", "dialog.ac3", "score.dts"]) {
			expect((await resolveTrackSource(track(name), new AbortController().signal)).media.kind).toBe("url")
		}

		await resolveTrackSource(track("untyped.mp3", null), new AbortController().signal)

		expect(openDecodedAudioStream).toHaveBeenCalledTimes(4)
		expect(previewStreamUrl).not.toHaveBeenCalled()

		const source = await resolveTrackSource(track("x.mka"), new AbortController().signal)

		source.release()
		expect(stream.release).toHaveBeenCalledOnce()
		// Four still held, the released one let go.
		expect(alive.held).toBe(4)
	})

	it("fails with the format when nothing in the file decodes", async () => {
		openDecodedAudioStream.mockRejectedValue(Object.assign(new Error("no decoder"), { name: AUDIO_UNSUPPORTED_ERROR }))

		const error = await resolveTrackSource(track("x.mka"), new AbortController().signal).then(
			() => null,
			(rejection: unknown) => asErrorDTO(rejection)
		)

		expect(error?.kind).toBe(MEDIA_FORMAT_UNSUPPORTED)
	})

	it("plays through MediaSource where the service worker cannot take the stream, or there is none", async () => {
		const media = { attach: vi.fn(() => Promise.resolve()), dispose: vi.fn() }

		audioMediaSource.mockReturnValue(media)
		openDecodedAudioStream.mockRejectedValue(new Error("the service worker cannot serve this preview"))

		const fallback = await resolveTrackSource(track("x.mka"), new AbortController().signal)

		expect(fallback.media.kind).toBe("session")

		streaming.value = false

		const source = await resolveTrackSource(track("a.mp3"), new AbortController().signal)

		expect(source.media.kind).toBe("session")
		expect(previewStreamUrl).not.toHaveBeenCalled()

		source.release()
		expect(media.dispose).toHaveBeenCalledOnce()
	})

	it("plays a synthesized song through its decoded stream alone, with the synthesizer named, never MediaSource", async () => {
		openDecodedAudioStream.mockResolvedValue(decoded("/sw/download/wav"))

		await resolveTrackSource(track("song.mid", "audio/midi"), new AbortController().signal)
		expect(openDecodedAudioStream).toHaveBeenLastCalledWith(expect.objectContaining({ synth: "midi" }))
		await resolveTrackSource(track("tune.xm", null), new AbortController().signal)
		expect(openDecodedAudioStream).toHaveBeenLastCalledWith(expect.objectContaining({ synth: "module" }))

		openDecodedAudioStream.mockRejectedValue(new Error("the service worker cannot serve this preview"))
		await expect(resolveTrackSource(track("tune.it", null), new AbortController().signal)).rejects.toThrow()

		streaming.value = false
		await expect(resolveTrackSource(track("tune.s3m", null), new AbortController().signal)).rejects.toThrow()
		expect(audioMediaSource).not.toHaveBeenCalled()
	})

	it("hands back a stream that resolved after its load was abandoned", async () => {
		const abort = new AbortController()
		const stream = decoded("/sw/download/wav")

		openDecodedAudioStream.mockImplementation(() => {
			abort.abort()

			return Promise.resolve(stream)
		})

		await expect(resolveTrackSource(track("x.mka"), abort.signal)).rejects.toThrow()
		expect(stream.release).toHaveBeenCalledOnce()

		const second = new AbortController()

		previewStreamUrl.mockImplementationOnce((_file, _name, _type, id) => {
			second.abort()

			return Promise.resolve(`/sw/download/${id}`)
		})

		await expect(resolveTrackSource(track("a.mp3"), second.signal)).rejects.toThrow()
		expect(releasePreviewStream).toHaveBeenCalledOnce()
	})
})
