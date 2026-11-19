import { describe, expect, it } from "vitest"
import {
	BlockSource,
	bytesReadRange,
	type ReadRange,
	CARD_BLOCK_READS,
	initialBlockReads,
	probeVideo,
	walkContainer,
	type ProbeTier,
	type VideoProbe
} from "@filen/shared/videos"
import {
	AC3_51,
	ADTS_LC_48K_STEREO,
	AVC_SPS,
	HEVC_SPS,
	annexB,
	bdav,
	language,
	nulls,
	packet,
	pat,
	patOf,
	pes,
	pmt,
	registration,
	type EsEntry
} from "@/tests/support/mpegtsBytes"

const PMT_PID = 0x1000
const VIDEO_PID = 0x100
const AUDIO_PID = 0x101
const START_PTS = 126_000

async function probe(
	bytes: readonly number[] | Uint8Array,
	tier: ProbeTier = "full"
): Promise<{ record: VideoProbe | null; reads: number }> {
	const data = Uint8Array.from(bytes)
	const source = new BlockSource(data.length, bytesReadRange(data), { maxBlockReads: initialBlockReads(tier) })
	const record = await probeVideo(source, tier)

	return { record, reads: source.blockReads }
}

// PAT, PMT, then each stream's first PES, padding, and the tail's PES.
function stream(params: {
	streams: EsEntry[]
	programDescriptors?: number[]
	first?: number[]
	tail?: number[]
	padding?: number
}): number[] {
	return [
		...pat(PMT_PID),
		...pmt(PMT_PID, params.streams, params.programDescriptors),
		...(params.first ?? []),
		...nulls(params.padding ?? 20),
		...(params.tail ?? [])
	]
}

function h264Aac(lastPts = START_PTS + 30 * 90_000): number[] {
	return stream({
		streams: [
			{ type: 0x1b, pid: VIDEO_PID },
			{ type: 0x0f, pid: AUDIO_PID, descriptors: language("eng") }
		],
		first: [...pes(VIDEO_PID, 0xe0, START_PTS, annexB(AVC_SPS)), ...pes(AUDIO_PID, 0xc0, START_PTS, [...ADTS_LC_48K_STEREO, 0, 0, 0])],
		tail: [
			...pes(VIDEO_PID, 0xe0, lastPts - 3600, annexB([0x41, 0x9a])),
			...pes(VIDEO_PID, 0xe0, lastPts, annexB([0x41, 0x9a])),
			...pes(VIDEO_PID, 0xe0, lastPts - 7200, annexB([0x41, 0x9a]))
		]
	})
}

describe("MPEG-TS probe", () => {
	it("reads H.264 and AAC from 188-byte packets", async () => {
		const { record } = await probe(h264Aac())

		expect(record).toEqual({
			v: 1,
			container: "ts",
			durationSec: 30,
			index: "none",
			video: {
				codec: "h264",
				fourcc: "avc1",
				codecString: "avc1.64001f",
				w: 1280,
				h: 720,
				par: 1,
				rotation: 0,
				bitDepth: 8,
				transfer: "sdr",
				// The SPS's VUI timing: a tick of 1/48 s, two a frame.
				fps: 24
			},
			audio: [
				{
					id: AUDIO_PID,
					codec: "aac",
					codecString: "mp4a.40.2",
					ch: 2,
					rate: 48000,
					lang: "eng",
					name: null,
					def: true,
					forced: false,
					commentary: false
				}
			],
			subs: [],
			chapters: [],
			cover: null,
			coverLand: null,
			partial: false
		})
	})

	it("reads 192-byte BDAV units the same way", async () => {
		const { record } = await probe(bdav(h264Aac()))

		expect(record?.container).toBe("ts")
		expect(record?.video?.codecString).toBe("avc1.64001f")
		expect(record?.audio[0]?.codecString).toBe("mp4a.40.2")
		expect(record?.durationSec).toBe(30)
	})

	it("reads HEVC from its SPS, and AC-3 channels from the sync frame behind a DVB descriptor", async () => {
		const { record } = await probe(
			stream({
				streams: [
					{ type: 0x24, pid: VIDEO_PID },
					{ type: 0x06, pid: AUDIO_PID, descriptors: [...language("deu"), 0x6a, 1, 0x00] }
				],
				first: [...pes(VIDEO_PID, 0xe0, START_PTS, annexB(HEVC_SPS)), ...pes(AUDIO_PID, 0xbd, START_PTS, AC3_51)],
				tail: pes(VIDEO_PID, 0xe0, START_PTS + 90_000, annexB([0x02, 0x01]))
			})
		)

		expect(record?.video).toMatchObject({
			codec: "hevc",
			fourcc: "hvc1",
			codecString: "hvc1.2.4.L93.90",
			w: 1280,
			h: 720,
			bitDepth: 10
		})
		expect(record?.audio).toMatchObject([{ codec: "ac3", codecString: "ac-3", ch: 6, rate: 48000, lang: "deu" }])
		expect(record?.durationSec).toBe(1)
		expect(record?.partial).toBe(false)
	})

	it("maps stream types as the remux's demuxer does", async () => {
		const audio = (type: number, pid: number, descriptors: number[] = []): EsEntry => ({ type, pid, descriptors })
		const types = [
			audio(0x81, 0x110),
			audio(0x87, 0x111),
			audio(0x82, 0x112),
			audio(0x8a, 0x113),
			audio(0x11, 0x114),
			audio(0x06, 0x115, [0x7a, 0]),
			audio(0x06, 0x116, registration("DTS2")),
			// Private data without a known descriptor (subtitles, teletext), and stream types that mean
			// something else outside Blu-ray (SCTE-35 cues): no tracks.
			audio(0x06, 0x117, [0x59, 0]),
			audio(0x86, 0x118),
			audio(0x85, 0x119)
		]
		const { record } = await probe(stream({ streams: [{ type: 0x02, pid: VIDEO_PID }, ...types] }))

		expect(record?.video).toMatchObject({ codec: null, fourcc: "mp2v", codecString: null })
		expect(record?.audio.map(track => [track.id, track.codec, track.codecString])).toEqual([
			[0x110, "ac3", "ac-3"],
			[0x111, "eac3", "ec-3"],
			[0x112, "dts", "dtsc"],
			[0x113, "dts", "dtsc"],
			[0x114, null, null],
			[0x115, "eac3", "ec-3"],
			[0x116, "dts", "dtsc"]
		])
		expect(record?.audio.map(track => track.def)).toEqual([true, false, false, false, false, false, false])
	})

	it("reads Blu-ray stream types only in a program registered as HDMV", async () => {
		const streams: EsEntry[] = [
			{ type: 0x1b, pid: 0x1011 },
			{ type: 0x86, pid: 0x1100 },
			{ type: 0x85, pid: 0x1101 },
			{ type: 0xa2, pid: 0x1a00 },
			{ type: 0x83, pid: 0x1102 },
			{ type: 0x80, pid: 0x1103 },
			{ type: 0x84, pid: 0x1104 }
		]
		const { record } = await probe(bdav(stream({ streams, programDescriptors: registration("HDMV") })))

		expect(record?.audio.map(track => [track.id, track.codec, track.codecString])).toEqual([
			[0x1100, "dts", "dtsl"],
			[0x1101, "dts", "dtsh"],
			[0x1a00, "dts", "dtse"],
			[0x1102, "truehd", "mlpa"],
			[0x1103, null, null],
			[0x1104, null, null]
		])
	})

	it("names MPEG audio by layer, with a codec string for MP3 only", async () => {
		const layer2 = [0xff, 0xfd, 0x84, 0x04]
		const layer3 = [0xff, 0xfb, 0x90, 0xc4]
		const { record } = await probe(
			stream({
				streams: [
					{ type: 0x03, pid: 0x110 },
					{ type: 0x04, pid: 0x111 }
				],
				first: [...pes(0x110, 0xc0, START_PTS, layer2), ...pes(0x111, 0xc1, START_PTS, layer3)]
			})
		)

		expect(record?.video).toBeNull()
		expect(record?.audio.map(track => [track.codec, track.codecString, track.ch, track.rate])).toEqual([
			["mp2", null, 2, 48000],
			["mp3", "mp4a.6B", 1, 44100]
		])
	})

	it("times an audio-only stream by its first audio track, across a PTS wrap", async () => {
		const first = 2 ** 33 - 90_000
		const { record } = await probe(
			stream({
				streams: [{ type: 0x0f, pid: AUDIO_PID }],
				first: pes(AUDIO_PID, 0xc0, first, ADTS_LC_48K_STEREO),
				tail: pes(AUDIO_PID, 0xc0, 4 * 90_000, ADTS_LC_48K_STEREO)
			})
		)

		expect(record?.video).toBeNull()
		expect(record?.durationSec).toBe(5)
	})

	it("finds the tail's packets when the grid moved (a capture cut and joined)", async () => {
		const bytes = [...h264Aac().slice(0, -3 * 188 * 2), 0x00, 0x00, 0x00, ...h264Aac().slice(-3 * 188 * 2)]
		const { record } = await probe(bytes)

		expect(record?.durationSec).toBe(30)
	})

	it("is partial without the SPS, with no size and no codec string", async () => {
		const { record } = await probe(
			stream({
				streams: [{ type: 0x1b, pid: VIDEO_PID }],
				first: pes(VIDEO_PID, 0xe0, START_PTS, [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65, 0x88]),
				tail: pes(VIDEO_PID, 0xe0, START_PTS + 90_000, [0, 0, 1, 0x41])
			})
		)

		expect(record?.video).toMatchObject({ codec: "h264", codecString: null, w: 0, h: 0, bitDepth: null })
		expect(record?.partial).toBe(true)
	})

	it("reports no tracks when the PMT never comes, and refuses a section longer than its packets", async () => {
		expect((await probe([...pat(PMT_PID), ...nulls(10)])).record).toMatchObject({
			container: "ts",
			video: null,
			audio: [],
			partial: true
		})

		const truncated = packet(PMT_PID, [0, 0x02, 0xb3, 0xff, 0x00, 0x01], true)

		expect((await probe([...pat(PMT_PID), ...truncated, ...nulls(10)])).record?.partial).toBe(true)
	})

	it("leaves LATM AAC without a codec: the remux's demuxer does not read it", async () => {
		const { record } = await probe(stream({ streams: [{ type: 0x11, pid: AUDIO_PID }] }))

		expect(record?.audio).toMatchObject([{ id: AUDIO_PID, codec: null, codecString: null }])
	})

	it("refuses a PAT with more than one program, or none", async () => {
		const body = [...pmt(PMT_PID, [{ type: 0x1b, pid: VIDEO_PID }]), ...pes(VIDEO_PID, 0xe0, START_PTS, annexB(AVC_SPS)), ...nulls(10)]

		expect(
			(
				await probe([
					...patOf([
						[1, PMT_PID],
						[2, PMT_PID + 1]
					]),
					...body
				])
			).record
		).toBeNull()
		expect((await probe([...patOf([]), ...body])).record).toBeNull()
		expect((await probe([...patOf([[0, 0x10]]), ...body])).record).toBeNull()
		expect(
			(
				await probe([
					...patOf([
						[0, 0x10],
						[1, PMT_PID]
					]),
					...body
				])
			).record?.video?.codecString
		).toBe("avc1.64001f")
	})

	it("refuses text and too few packets", async () => {
		const text = new TextEncoder().encode(`${"G".repeat(4)}const x = 1\n`.repeat(200))

		expect((await probe(text)).record).toBeNull()
		expect((await probe([...pat(PMT_PID), ...pat(PMT_PID)])).record).toBeNull()

		const shifted = h264Aac()

		shifted[188 * 2] = 0x48

		expect((await probe(shifted)).record).toBeNull()
	})

	it("names the tracks within the card's read budget", async () => {
		const data = Uint8Array.from(h264Aac())
		const parsed = await walkContainer(new BlockSource(data.length, bytesReadRange(data), { maxBlockReads: CARD_BLOCK_READS }), "card")
		const tracks = parsed?.tracks.map(track =>
			track.kind === "video"
				? { kind: "video", codec: track.video.codec }
				: track.kind === "audio"
					? { kind: "audio", codec: track.audio.codec }
					: { kind: track.kind }
		)

		expect(tracks).toEqual([
			{ kind: "video", codec: "h264" },
			{ kind: "audio", codec: "aac" }
		])
	})

	it("never finds keyframes to index", async () => {
		const data = Uint8Array.from(h264Aac())
		const parsed = await walkContainer(new BlockSource(data.length, bytesReadRange(data)), "card", { keyframes: true })

		expect(parsed?.tracks[0]).not.toHaveProperty("decode")
	})
})

// A large stream whose video never carries an SPS, synthesised block by block.
function endlessStream(): ReadRange {
	const head = Uint8Array.from([...pat(PMT_PID), ...pmt(PMT_PID, [{ type: 0x1b, pid: VIDEO_PID }])])
	const filler = Uint8Array.from(packet(VIDEO_PID, new Array<number>(184).fill(0x88), false))

	return (start, end) => {
		const out = new Uint8Array(end - start)

		for (let at = start - (start % 188); at < end; at += 188) {
			const index = at / 188
			const bytes =
				index < 2
					? head.subarray(index * 188, index * 188 + 188)
					: index % 400 === 2
						? Uint8Array.from(pes(VIDEO_PID, 0xe0, START_PTS + index * 30, [0, 0, 1, 0x09, 0xf0]))
						: filler

			for (let i = 0; i < 188; i++) {
				const position = at + i

				if (position >= start && position < end) {
					out[position - start] = bytes[i] ?? 0
				}
			}
		}

		return Promise.resolve(out)
	}
}

describe("MPEG-TS probe budgets", () => {
	for (const [tier, limit] of [
		["card", CARD_BLOCK_READS],
		["cover", CARD_BLOCK_READS],
		["full", 6]
	] as const) {
		it(`stays within ${String(limit)} block reads for the ${tier} tier`, async () => {
			const size = 188 * 400_000
			const source = new BlockSource(size, endlessStream(), { maxBlockReads: initialBlockReads(tier) })
			const record = await probeVideo(source, tier)

			expect(source.blockReads).toBeLessThanOrEqual(limit)
			expect(record).toMatchObject({ container: "ts", partial: true, video: { codec: "h264", codecString: null } })
			expect(record?.durationSec).toBeGreaterThan(0)
		})
	}
})
