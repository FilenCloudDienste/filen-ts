import { afterEach, describe, expect, it, vi } from "vitest"
import { ENCODE_PROBE_HEIGHT, ENCODE_PROBE_WIDTH, HEVC_MAIN10_CODEC_STRING } from "@/lib/media/playback/capabilities.logic"

// The encoder probe the remux worker runs: mediabunny's checks at 1080p with no hardware preference, HEVC Main 10
// only where HEVC encodes at all, and a check that throws counted as a no.

const encodable = vi.hoisted(() => ({
	video: new Set<string>(),
	main10: false,
	audio: new Set<string>(),
	calls: [] as { codec: string; options: Record<string, unknown> }[]
}))

vi.mock("mediabunny", () => {
	const canEncodeVideo = (codec: string, options: Record<string, unknown>) => {
		encodable.calls.push({ codec, options })

		if (codec === "av1") {
			return Promise.reject(new TypeError("unknown config"))
		}

		return Promise.resolve(options["fullCodecString"] === undefined ? encodable.video.has(codec) : encodable.main10)
	}

	return {
		canEncodeVideo,
		canEncodeAudio: (codec: string) => Promise.resolve(encodable.audio.has(codec)),
		getFirstEncodableVideoCodec: async (codecs: string[], options: Record<string, unknown>) => {
			for (const codec of codecs) {
				if (await canEncodeVideo(codec, options).catch(() => false)) {
					return codec
				}
			}

			return null
		}
	}
})

const { probeEncodeCapabilities } = await import("@/workers/remux/encodeCaps")

afterEach(() => {
	encodable.video.clear()
	encodable.audio.clear()
	encodable.main10 = false
	encodable.calls.length = 0
})

describe("probeEncodeCapabilities", () => {
	it("reports each codec, HEVC Main 10 and the first export codec", async () => {
		encodable.video.add("hevc").add("vp9")
		encodable.main10 = true
		encodable.audio.add("opus")

		const caps = await probeEncodeCapabilities()

		expect(caps.video).toEqual({ avc: false, hevc: true, hevcMain10: true, vp9: true, av1: false })
		expect(caps.firstVideoCodec).toBe("hevc")
		expect(caps.audio).toEqual({ aac: false, opus: true })
		expect(encodable.calls.every(({ options }) => options["hardwareAcceleration"] === "no-preference")).toBe(true)
		expect(
			encodable.calls.every(({ options }) => options["width"] === ENCODE_PROBE_WIDTH && options["height"] === ENCODE_PROBE_HEIGHT)
		).toBe(true)
		expect(encodable.calls.some(({ options }) => options["fullCodecString"] === HEVC_MAIN10_CODEC_STRING)).toBe(true)
	})

	it("does not ask for Main 10 where HEVC does not encode", async () => {
		encodable.video.add("avc")
		encodable.main10 = true

		const caps = await probeEncodeCapabilities()

		expect(caps.video.hevcMain10).toBe(false)
		expect(caps.firstVideoCodec).toBe("avc")
		expect(encodable.calls.some(({ options }) => options["fullCodecString"] !== undefined)).toBe(false)
	})

	it("answers no video codec when nothing encodes", async () => {
		const caps = await probeEncodeCapabilities()

		expect(caps.firstVideoCodec).toBeNull()
		expect(Object.values(caps.video).every(value => !value)).toBe(true)
	})
})
