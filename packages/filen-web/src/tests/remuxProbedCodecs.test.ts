import { describe, expect, it } from "vitest"
import { ALL_FORMATS, BufferSource, Input } from "mediabunny"
import { BlockCache } from "@/lib/media/blockCache"
import { probedCodecFor, probedCodecs, waveProbedCodec } from "@/workers/remux/audioInput"
import {
	FTYP,
	audioEntry,
	box,
	concat,
	ebmlHeader,
	element,
	esds,
	f64,
	fullBox,
	hdlr,
	mdhd,
	mvhd,
	segment,
	stringElement,
	tkhd,
	trak,
	uintElement,
	videoEntry
} from "@/tests/support/containerBytes"

// x264 High@L3.1, as in the fixtures.
const AVCC = box(
	"avcC",
	Array.from(Buffer.from("0164001fffe1001a6764001facd9405005bb011000000300100000030300f183196001000468ef89cbfdf8f800", "hex"))
)
const AAC_LC_48K_STEREO = [0x11, 0x90]
// ALAC's 24-byte config: frame length 4096, 16-bit, stereo, 44.1 kHz.
const ALAC_COOKIE = Uint8Array.from([0, 0, 0x10, 0, 0, 16, 40, 10, 14, 2, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xac, 0x44])

function cacheOf(bytes: Uint8Array): BlockCache {
	return new BlockCache(bytes.length, (start, end) => Promise.resolve(bytes.slice(start, end)))
}

// Each audio track as mediabunny lists it, with the walked codec it is matched to.
async function matched(bytes: Uint8Array): Promise<{ id: number; number: number; codec: string | null; walked: string | null }[]> {
	const probed = await probedCodecs(cacheOf(bytes))
	const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })

	try {
		const tracks = await input.getAudioTracks()

		return await Promise.all(
			tracks.map(async track => {
				const codec = await track.getCodec()

				return { id: track.id, number: track.number, codec, walked: probedCodecFor(probed, track.number, codec)?.codec ?? null }
			})
		)
	} finally {
		input.dispose()
	}
}

function trackEntry(number: number, type: number, codecId: string, ...fields: Uint8Array[]): Uint8Array {
	return element(0xae, uintElement(0xd7, number), uintElement(0x83, type), stringElement(0x86, codecId), ...fields)
}

const STEREO_48K = element(0xe1, element(0xb5, f64(48000)), uintElement(0x9f, 2))

describe("probedCodecs — container track IDs that are not mediabunny's track indices", () => {
	it("matches a Matroska file's TrueHD and ALAC tracks by their place among the audio tracks", async () => {
		const file = concat(
			ebmlHeader(),
			segment(
				element(0x1549a966, uintElement(0x2ad7b1, 1_000_000), element(0x4489, f64(30_037))),
				element(
					0x1654ae6b,
					trackEntry(
						5,
						1,
						"V_MPEG4/ISO/AVC",
						element(0x63a2, AVCC.subarray(8)),
						element(0xe0, uintElement(0xb0, 1920), uintElement(0xba, 1080))
					),
					trackEntry(7, 2, "A_AAC", element(0x63a2, AAC_LC_48K_STEREO), STEREO_48K),
					trackEntry(9, 2, "A_TRUEHD", STEREO_48K),
					trackEntry(12, 2, "A_ALAC", element(0x63a2, ALAC_COOKIE), STEREO_48K)
				)
			)
		)

		expect([...(await probedCodecs(cacheOf(file))).entries()].map(([number, known]) => [number, known.codec])).toEqual([
			[2, "truehd"],
			[3, "alac"]
		])
		expect(await matched(file)).toEqual([
			{ id: 2, number: 1, codec: "aac", walked: null },
			{ id: 3, number: 2, codec: "truehd", walked: "truehd" },
			{ id: 4, number: 3, codec: null, walked: "alac" }
		])
	})

	it("matches an MP4's ALAC track the same way", async () => {
		const file = concat(
			FTYP,
			box(
				"moov",
				mvhd({ duration: 1000 }),
				trak(tkhd({ id: 3 }), [mdhd({}), hdlr("vide")], videoEntry("avc1", {}, AVCC)),
				trak(tkhd({ id: 8 }), [mdhd({}), hdlr("soun")], audioEntry("mp4a", {}, esds(0x40, AAC_LC_48K_STEREO))),
				trak(tkhd({ id: 11 }), [mdhd({}), hdlr("soun")], audioEntry("alac", { rate: 44_100 }, fullBox("alac", 0, 0, ALAC_COOKIE)))
			)
		)

		expect(await matched(file)).toEqual([
			{ id: 2, number: 1, codec: "aac", walked: null },
			{ id: 3, number: 2, codec: null, walked: "alac" }
		])
	})

	it("leaves a track whose own codec disagrees with the walk's", () => {
		const probed = new Map([[2, { codec: "truehd" as const }]])

		expect(probedCodecFor(probed, 2, "aac")).toBeNull()
		expect(probedCodecFor(probed, 2, "truehd")?.codec).toBe("truehd")
		expect(probedCodecFor(probed, 2, null)?.codec).toBe("truehd")
		expect(probedCodecFor(probed, 1, null)).toBeNull()
	})

	it("takes the walk's MP1 or MP2 over the MP3 mediabunny calls any MPEG audio, and no other codec over MP3", () => {
		const probed = new Map([
			[1, { codec: "mp2" as const }],
			[2, { codec: "wmav2" as const }]
		])

		expect(probedCodecFor(probed, 1, "mp3")?.codec).toBe("mp2")
		expect(probedCodecFor(probed, 2, "mp3")).toBeNull()
	})
})

// A WAVEFORMATEX: tag, channels, rate, bytes per second, block size, bits per sample, then its extra bytes.
function waveFormat(
	tag: number,
	channels: number,
	rate: number,
	bytesPerSecond: number,
	blockAlign: number,
	bits: number,
	extra: number[]
): Uint8Array {
	const out = new Uint8Array(18 + extra.length)
	const view = new DataView(out.buffer)

	view.setUint16(0, tag, true)
	view.setUint16(2, channels, true)
	view.setUint32(4, rate, true)
	view.setUint32(8, bytesPerSecond, true)
	view.setUint16(12, blockAlign, true)
	view.setUint16(14, bits, true)
	view.setUint16(16, extra.length, true)
	out.set(extra, 18)

	return out
}

describe("waveProbedCodec", () => {
	it("picks WMA's and ADPCM's decoder by the format tag, with the format's fields and extra bytes", () => {
		expect(waveProbedCodec("wma", waveFormat(0x0161, 2, 44_100, 16_000, 2973, 16, [0, 0, 0, 0, 1, 0]), null, null)).toEqual({
			codec: "wmav2",
			extradata: Uint8Array.from([0, 0, 0, 0, 1, 0]),
			stream: { blockAlign: 2973, bitRate: 128_000, sampleRate: 44_100, channels: 2, bitsPerSample: 16 }
		})
		expect(waveProbedCodec("wma", waveFormat(0x0160, 1, 22_050, 4000, 742, 16, []), null, null)?.codec).toBe("wmav1")
		expect(waveProbedCodec("adpcm", waveFormat(0x0002, 1, 22_050, 11_100, 512, 4, [0xf4, 0x01]), null, null)?.codec).toBe("adpcm_ms")
		expect(waveProbedCodec("adpcm", waveFormat(0x0011, 1, 22_050, 11_100, 512, 4, [0xf9, 0x01]), null, null)?.codec).toBe(
			"adpcm_ima_wav"
		)
	})

	it("names the decoders that need no format, from the walk's rate and channels, and nothing else", () => {
		expect(waveProbedCodec("amr", null, 8000, 1)).toMatchObject({ codec: "amrnb", stream: { sampleRate: 8000, channels: 1 } })
		expect(waveProbedCodec("mp2", null, 48_000, 2)?.codec).toBe("mp2")
		expect(waveProbedCodec("aac", null, 48_000, 2)).toBeNull()
		expect(waveProbedCodec("wma", Uint8Array.of(1, 2), null, null)).toMatchObject({ codec: "wmav2", stream: { blockAlign: 0 } })
	})
})
