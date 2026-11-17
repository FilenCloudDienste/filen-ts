import { describe, expect, it } from "vitest"
import { mpegAudioHeader } from "@filen/shared/videos"

function header(...bytes: number[]): ReturnType<typeof mpegAudioHeader> {
	return mpegAudioHeader(Uint8Array.from([...bytes, 0]), 0)
}

describe("mpegAudioHeader", () => {
	it("reads MPEG-1 layer III, 128 kbps, 44.1 kHz stereo as 417-byte frames of 1152 samples", () => {
		expect(header(0xff, 0xfb, 0x90, 0x00)).toEqual({
			version: 1,
			layer: 3,
			rate: 44100,
			channels: 2,
			samples: 1152,
			frameBytes: 417,
			sideInfoBytes: 32,
			shape: (0xfb << 8) | 0x00
		})
		expect(header(0xff, 0xfb, 0x92, 0x00)?.frameBytes).toBe(418)
		expect(header(0xff, 0xfb, 0x90, 0xc0)).toMatchObject({ channels: 1, sideInfoBytes: 17 })
	})

	it("names layers I and II with their own frame lengths", () => {
		expect(header(0xff, 0xfd, 0x90, 0x00)).toMatchObject({ layer: 2, samples: 1152, frameBytes: 522, sideInfoBytes: 0 })
		expect(header(0xff, 0xff, 0x90, 0x00)).toMatchObject({ layer: 1, samples: 384, frameBytes: 312, sideInfoBytes: 0 })
	})

	it("reads MPEG-2 and MPEG-2.5 rates and layer III frames of 576 samples", () => {
		expect(header(0xff, 0xf3, 0x90, 0x00)).toMatchObject({ version: 2, layer: 3, rate: 22050, samples: 576, frameBytes: 261 })
		expect(header(0xff, 0xe3, 0x90, 0x00)).toMatchObject({ version: 2.5, layer: 3, rate: 11025, samples: 576, frameBytes: 522 })
	})

	it("states no length for a free-format frame", () => {
		expect(header(0xff, 0xfb, 0x00, 0x00)).toMatchObject({ layer: 3, frameBytes: null })
	})

	it("refuses reserved versions, layers, bitrates and rates", () => {
		expect(header(0xff, 0xeb, 0x90, 0x00)).toBeNull()
		expect(header(0xff, 0xf9, 0x90, 0x00)).toBeNull()
		expect(header(0xff, 0xfb, 0xf0, 0x00)).toBeNull()
		expect(header(0xff, 0xfb, 0x9c, 0x00)).toBeNull()
		expect(header(0xfe, 0xfb, 0x90, 0x00)).toBeNull()
	})
})
