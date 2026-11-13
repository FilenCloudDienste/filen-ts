import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	BlockSource,
	bytesReadRange,
	blockFrameStart,
	chunkOfSample,
	cueAtOrBefore,
	indexedKeyframeTimes,
	openKeyframeIndex,
	parseCues,
	readKeyframe,
	sampleAtTime,
	sampleTime,
	syncSampleAtOrBefore
} from "@filen/shared/videos"
import { MEDIA_DIR, fileReadRange } from "@/tests/support/videoProbe"
import {
	FTYP,
	box,
	concat,
	ebmlHeader,
	ebmlId,
	element,
	f64,
	fullBox,
	hdlr,
	mdhd,
	mvhd,
	segment,
	stringElement,
	tkhd,
	u32,
	uintElement,
	videoEntry
} from "@/tests/support/containerBytes"

function table(...values: number[]): Uint8Array {
	return concat(...values.map(value => u32(value)))
}

// x264 High@L3.1.
const AVC_PRIVATE = Uint8Array.from(
	Buffer.from("0164001fffe1001a6764001facd9405005bb011000000300100000030300f183196001000468ef89cbfdf8f800", "hex")
)

function sampleBytes(sample: number, size: number): Uint8Array {
	return new Uint8Array(size).fill(sample)
}

// Ten one-second samples (timescale 1000), keyframes 1, 4, 7, 10, three samples per chunk.
const SIZES = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]

function mp4(): { bytes: Uint8Array; sampleOffsets: number[] } {
	const moovFor = (chunkOffsets: number[]): Uint8Array =>
		box(
			"moov",
			mvhd({ timescale: 1000, duration: 10_000, nextTrackId: 2 }),
			box(
				"trak",
				tkhd({ id: 1 }),
				box(
					"mdia",
					mdhd({ timescale: 1000, duration: 10_000 }),
					hdlr("vide"),
					box(
						"minf",
						box(
							"stbl",
							fullBox("stsd", 0, 0, u32(1), videoEntry("avc1", {}, box("avcC", AVC_PRIVATE))),
							fullBox("stts", 0, 0, table(1, 10, 1000)),
							fullBox("stss", 0, 0, table(4, 1, 4, 7, 10)),
							fullBox("stsc", 0, 0, table(1, 1, 3, 1)),
							fullBox("stsz", 0, 0, table(0, 10, ...SIZES)),
							fullBox("stco", 0, 0, table(chunkOffsets.length, ...chunkOffsets))
						)
					)
				)
			)
		)
	const head = FTYP.length + moovFor([0, 0, 0, 0]).length + 8
	const sampleOffsets: number[] = []
	let at = head

	for (const size of SIZES) {
		sampleOffsets.push(at)
		at += size
	}

	const chunkOffsets = [0, 3, 6, 9].map(sample => sampleOffsets[sample] ?? 0)
	const mdat = box("mdat", ...SIZES.map((size, i) => sampleBytes(i + 1, size)))

	return { bytes: concat(FTYP, moovFor(chunkOffsets), mdat), sampleOffsets }
}

// A SimpleBlock of track 1: track number, timecode, flags, then the frame.
function simpleBlock(key: boolean, frame: Uint8Array): Uint8Array {
	return element(0xa3, [0x81, 0, 0, key ? 0x80 : 0], frame)
}

const MKV_TRACKS = element(
	0x1654ae6b,
	element(
		0xae,
		uintElement(0xd7, 1),
		uintElement(0x83, 1),
		stringElement(0x86, "V_MPEG4/ISO/AVC"),
		element(0x63a2, AVC_PRIVATE),
		element(0xe0, uintElement(0xb0, 1280), uintElement(0xba, 720))
	)
)
const MKV_INFO = element(0x1549a966, uintElement(0x2ad7b1, 1_000_000), element(0x4489, f64(10_000)))

function cuePoint(time: number, cluster: number, relative: number | null): Uint8Array {
	return element(
		0xbb,
		uintElement(0xb3, time),
		element(0xb7, uintElement(0xf7, 1), element(0xf1, u32(cluster)), ...(relative === null ? [] : [element(0xf0, u32(relative))]))
	)
}

// Two clusters (0 s and 5 s); the first cue gives the block's relative position, the second does not.
function mkv(): { bytes: Uint8Array; frames: Uint8Array[]; frameOffsets: number[] } {
	const frames = [sampleBytes(0xa, 50), sampleBytes(0xb, 60), sampleBytes(0xc, 70)]
	const timestamp = uintElement(0xe7, 0)
	const cluster1 = element(
		0x1f43b675,
		timestamp,
		simpleBlock(true, frames[0] ?? new Uint8Array()),
		simpleBlock(false, frames[1] ?? new Uint8Array())
	)
	const cluster2 = element(
		0x1f43b675,
		uintElement(0xe7, 5000),
		element(0xa3, [0x82, 0, 0, 0x80], sampleBytes(9, 5)),
		simpleBlock(true, frames[2] ?? new Uint8Array())
	)
	const seekHeadFor = (positions: [number, number][]): Uint8Array =>
		element(0x114d9b74, ...positions.map(([id, at]) => element(0x4dbb, element(0x53ab, ebmlId(id)), element(0x53ac, u32(at)))))
	const seekLength = seekHeadFor([
		[0x1549a966, 0],
		[0x1654ae6b, 0],
		[0x1c53bb6b, 0]
	]).length
	const infoAt = seekLength
	const tracksAt = infoAt + MKV_INFO.length
	const cluster1At = tracksAt + MKV_TRACKS.length
	const cluster2At = cluster1At + cluster1.length
	const cuesAt = cluster2At + cluster2.length
	const cues = element(0x1c53bb6b, cuePoint(0, cluster1At, timestamp.length), cuePoint(5000, cluster2At, null))
	const seek = seekHeadFor([
		[0x1549a966, infoAt],
		[0x1654ae6b, tracksAt],
		[0x1c53bb6b, cuesAt]
	])
	const head = concat(ebmlHeader(), segment())
	const dataStart = head.length
	// Cluster header (4-byte id + 4-byte size), Timestamp, then each block's header (1 + 4) and its 4 leading bytes.
	const block1 = dataStart + cluster1At + 8 + timestamp.length
	const frameOffsets = [
		block1 + 5 + 4,
		block1 + 5 + 4 + 50 + 5 + 4,
		dataStart + cluster2At + 8 + uintElement(0xe7, 5000).length + 5 + 4 + 5 + 5 + 4
	]

	return { bytes: concat(head, seek, MKV_INFO, MKV_TRACKS, cluster1, cluster2, cues), frames, frameOffsets }
}

describe("MP4 sample tables", () => {
	const stts = table(3, 1000, 2, 500)

	it("finds the sample shown at a time and a sample's time", () => {
		expect(sampleAtTime(stts, 0)).toBe(1)
		expect(sampleAtTime(stts, 2999)).toBe(3)
		expect(sampleAtTime(stts, 3000)).toBe(4)
		expect(sampleAtTime(stts, 3600)).toBe(5)
		expect(sampleAtTime(stts, 1e9)).toBe(5)
		expect(sampleAtTime(new Uint8Array(), 10)).toBe(0)
		expect(sampleTime(stts, 4)).toBe(3000)
		expect(sampleTime(stts, 5)).toBe(3500)
	})

	it("finds the last sync sample at or before a sample, or the first one", () => {
		const stss = table(4, 9, 17)

		expect(syncSampleAtOrBefore(stss, 1)).toBe(4)
		expect(syncSampleAtOrBefore(stss, 9)).toBe(9)
		expect(syncSampleAtOrBefore(stss, 16)).toBe(9)
		expect(syncSampleAtOrBefore(stss, 100)).toBe(17)
		expect(syncSampleAtOrBefore(new Uint8Array(), 3)).toBeNull()
	})

	it("maps a sample to its chunk across stsc runs", () => {
		// Chunks 1-2 hold 3 samples, chunks 3+ hold 2.
		const stsc = table(1, 3, 1, 3, 2, 1)

		expect(chunkOfSample(stsc, 1)).toEqual({ chunk: 1, firstSample: 1 })
		expect(chunkOfSample(stsc, 6)).toEqual({ chunk: 2, firstSample: 4 })
		expect(chunkOfSample(stsc, 7)).toEqual({ chunk: 3, firstSample: 7 })
		expect(chunkOfSample(stsc, 10)).toEqual({ chunk: 4, firstSample: 9 })
		expect(chunkOfSample(table(1, 0, 1), 1)).toBeNull()
	})
})

describe("Matroska cues and blocks", () => {
	it("keeps only the track's cue points", () => {
		const cues = concat(
			element(0xbb, uintElement(0xb3, 0), element(0xb7, uintElement(0xf7, 2), element(0xf1, u32(10)))),
			element(0xbb, uintElement(0xb3, 40), element(0xb7, uintElement(0xf7, 1), element(0xf1, u32(20)), element(0xf0, u32(7))))
		)

		expect(parseCues(cues, 1)).toEqual({ times: [40], clusters: [20], relatives: [7] })
	})

	it("keeps every cue point of a dense index, past the generic EBML child cap", () => {
		const points = Array.from({ length: 15_000 }, (_, index) => cuePoint(index * 2000, index * 100, null))
		const cues = parseCues(concat(...points), 1)

		expect(cues.times.length).toBe(15_000)
		expect(cues.times[cueAtOrBefore(cues.times, 29_001_000)]).toBe(29_000_000)
		expect(cues.clusters.at(-1)).toBe(1_499_900)
	})

	it("picks the last cue at or before a time, else the first", () => {
		expect(cueAtOrBefore([0, 5000, 10_000], 7000)).toBe(1)
		expect(cueAtOrBefore([100, 200], 50)).toBe(0)
		expect(cueAtOrBefore([], 50)).toBe(-1)
	})

	it("reads a block's header, refusing another track and laced blocks", () => {
		expect(blockFrameStart(Uint8Array.from([0x81, 0, 0, 0x80]), 1)).toEqual({ headerLength: 4, key: true })
		expect(blockFrameStart(Uint8Array.from([0x40, 0x01, 0, 0, 0]), 1)).toEqual({ headerLength: 5, key: false })
		expect(blockFrameStart(Uint8Array.from([0x82, 0, 0, 0x80]), 1)).toBeNull()
		expect(blockFrameStart(Uint8Array.from([0x81, 0, 0, 0x82]), 1)).toBeNull()
	})
})

describe("openKeyframeIndex", () => {
	it("finds an MP4 keyframe through stss, stsc, stco and stsz", async () => {
		const { bytes, sampleOffsets } = mp4()
		const source = new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 8 })
		const index = await openKeyframeIndex(source)

		expect(index?.durationSec).toBe(10)
		expect(index?.decoder).toEqual({ codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE })

		// 5.5 s shows sample 6; the keyframe before it is sample 4, first of chunk 2.
		const ref = await index?.keyframeAt(5.5)

		expect(ref).toEqual({ offset: sampleOffsets[3], size: 103, timeSec: 3 })
		// Sample 8 sits third in chunk 3: its offset adds the two sizes before it.
		expect(await index?.keyframeAt(9.9)).toEqual({ offset: sampleOffsets[9], size: 109, timeSec: 9 })
		expect(await index?.keyframeAt(7.2)).toEqual({ offset: sampleOffsets[6], size: 106, timeSec: 6 })

		if (ref === undefined || ref === null) {
			throw new Error("no keyframe")
		}

		expect(await readKeyframe(source, ref)).toEqual(sampleBytes(4, 103))
	})

	it("finds a Matroska keyframe through the Cues, with and without a relative position", async () => {
		const { bytes, frames, frameOffsets } = mkv()
		const source = new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 8 })
		const index = await openKeyframeIndex(source)

		expect(index?.durationSec).toBe(10)
		expect(index?.decoder.codec).toBe("avc1.64001f")

		const first = await index?.keyframeAt(2)

		expect(first).toEqual({ offset: frameOffsets[0], size: 50, timeSec: 0 })

		// The second cluster opens with another track's block, then the keyframe.
		const second = await index?.keyframeAt(7)

		expect(second).toEqual({ offset: frameOffsets[2], size: 70, timeSec: 5 })

		if (second === undefined || second === null) {
			throw new Error("no keyframe")
		}

		expect(await readKeyframe(source, second)).toEqual(frames[2])
	})

	it("lists keyframe times from Matroska Cues, and leaves an MP4's sample tables to its demuxer", async () => {
		const { bytes } = mkv()

		expect(Array.from((await indexedKeyframeTimes(new BlockSource(bytes.length, bytesReadRange(bytes)))) ?? [])).toEqual([0, 5])

		const { bytes: moov } = mp4()

		expect(await indexedKeyframeTimes(new BlockSource(moov.length, bytesReadRange(moov)))).toBeNull()
	})

	it("has no index for Matroska without Cues or for a file that is no container", async () => {
		const noCues = concat(ebmlHeader(), segment(MKV_INFO, MKV_TRACKS, element(0x1f43b675, uintElement(0xe7, 0))))
		const text = new TextEncoder().encode("not a video at all, just text")

		expect(await openKeyframeIndex(new BlockSource(noCues.length, bytesReadRange(noCues)))).toBeNull()
		expect(await openKeyframeIndex(new BlockSource(text.length, bytesReadRange(text)))).toBeNull()
	})
})

// Real muxer output (pnpm run fixtures:videos), when present locally.
describe.skipIf(!existsSync(join(MEDIA_DIR, "manifest.json")))("openKeyframeIndex over the media fixtures", () => {
	const manifest = existsSync(join(MEDIA_DIR, "manifest.json"))
		? (JSON.parse(readFileSync(join(MEDIA_DIR, "manifest.json"), "utf8")) as {
				name: string
				streams: { type: string; codec: string }[]
			}[])
		: []
	const NO_INDEX = new Set(["h264-aac-nocues.mkv", "mpeg4-mp3.avi"])

	for (const { name, streams } of manifest) {
		it(`${name}: keyframes within eight block reads`, async () => {
			const file = await fileReadRange(join(MEDIA_DIR, name))

			try {
				const source = new BlockSource(file.size, file.readRange, { maxBlockReads: 8, cachedBlocks: 4 })
				const index = await openKeyframeIndex(source)

				if (NO_INDEX.has(name)) {
					expect(index).toBeNull()

					return
				}

				const duration = index?.durationSec ?? 0
				const ref = await index?.keyframeAt(duration * 0.18)

				if (index === null || ref === null || ref === undefined) {
					throw new Error("no keyframe")
				}

				const packet = await readKeyframe(source, ref)

				expect(source.blockReads).toBeLessThanOrEqual(8)
				expect(ref.timeSec).toBeLessThanOrEqual(duration * 0.18 + 0.05)

				// An H.264 keyframe's first picture NAL unit is an IDR slice (type 5).
				if (streams.find(stream => stream.type === "video")?.codec === "h264") {
					const types: number[] = []

					for (let at = 0; at + 4 < packet.length;) {
						const length =
							((packet[at] ?? 0) * 0x1000000 +
								((packet[at + 1] ?? 0) << 16) +
								((packet[at + 2] ?? 0) << 8) +
								(packet[at + 3] ?? 0)) >>>
							0

						types.push((packet[at + 4] ?? 0) & 0x1f)
						at += 4 + length
					}

					expect(types.find(type => type >= 1 && type <= 5)).toBe(5)
				}
			} finally {
				await file.close()
			}
		})
	}
})
