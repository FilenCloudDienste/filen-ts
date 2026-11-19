import { describe, expect, it } from "vitest"
import { BlockSource, bytesReadRange, probeVideo, type VideoProbe } from "@filen/shared/videos"

// Both MPEG walkers time a file by one rule: the timing stream's PTS span, head to tail, across one 33-bit wrap. A
// span of zero times nothing, so it leaves the duration unknown and the probe partial.

const PTS_WRAP = 2 ** 33
const AVC_SPS = [0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03]
const PICTURE = [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, ...AVC_SPS, 0x03, 0x00, 0xf1, 0x83, 0x19, 0x60, 0, 0, 0, 1, 0x65, 0x88, 0x88]

async function probe(bytes: readonly number[]): Promise<VideoProbe | null> {
	const data = Uint8Array.from(bytes)

	return probeVideo(new BlockSource(data.length, bytesReadRange(data), { maxBlockReads: 6 }), "full")
}

function ptsField(pts: number, marker: number): number[] {
	const high = Math.floor(pts / 2 ** 30)
	const low = pts % 2 ** 30

	return [
		(marker << 4) | ((high & 0x07) << 1) | 1,
		(low >>> 22) & 0xff,
		((low >>> 14) & 0xfe) | 1,
		(low >>> 7) & 0xff,
		((low << 1) & 0xfe) | 1
	]
}

// ── MPEG-TS ──

const PMT_PID = 0x1000
const VIDEO_PID = 0x100

function tsPacket(pid: number, payload: readonly number[], unitStart: boolean): number[] {
	const header = [0x47, (unitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f), pid & 0xff]

	if (payload.length >= 184) {
		return [...header, 0x10, ...payload]
	}

	const stuffing = 183 - payload.length
	const adaptation = stuffing === 0 ? [0] : [stuffing, 0x00, ...new Array<number>(stuffing - 1).fill(0xff)]

	return [...header, 0x30, ...adaptation, ...payload]
}

function section(tableId: number, body: readonly number[]): number[] {
	const length = body.length + 4

	return [tableId, 0xb0 | (length >> 8), length & 0xff, ...body, 0, 0, 0, 0]
}

function transportStream(firstPts: number, lastPts: number): number[] {
	const pat = tsPacket(0, [0, ...section(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff])], true)
	const pmt = tsPacket(
		PMT_PID,
		[
			0,
			...section(0x02, [
				0x00,
				0x01,
				0xc1,
				0x00,
				0x00,
				0xe1,
				0x00,
				0xf0,
				0x00,
				0x1b,
				0xe0 | (VIDEO_PID >> 8),
				VIDEO_PID & 0xff,
				0xf0,
				0x00
			])
		],
		true
	)
	const pes = (pts: number): number[] => tsPacket(VIDEO_PID, [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...ptsField(pts, 2), ...PICTURE], true)
	const nulls = Array.from({ length: 20 }, () => tsPacket(0x1fff, new Array<number>(184).fill(0xff), false)).flat()

	return [...pat, ...pmt, ...pes(firstPts), ...nulls, ...pes(lastPts)]
}

// ── MPEG-PS ──

function pack(): number[] {
	return [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0x01, 0x89, 0xc3, 0xf8]
}

function psPes(pts: number, payload: readonly number[]): number[] {
	const header = [0x80, 0x80, 5, ...ptsField(pts, 2)]
	const length = header.length + payload.length

	return [0, 0, 1, 0xe0, length >> 8, length & 0xff, ...header, ...payload]
}

function programStream(firstPts: number, lastPts: number): number[] {
	const sequenceHeader = [0, 0, 1, 0xb3, 0x2d, 0x02, 0x40, 0x24, 0xff, 0xff, 0xe0, 0x18, 0, 0, 1, 0xb5, 0x14, 0x8a, 0, 1, 0, 0]

	return [...pack(), ...psPes(firstPts, sequenceHeader), ...pack(), ...psPes(lastPts, [0, 0, 1, 0])]
}

describe.each([
	["MPEG-TS", transportStream, "ts"],
	["MPEG-PS", programStream, "ps"]
] as const)("%s duration", (_, build, container) => {
	it("spans the timing stream's PTS head to tail", async () => {
		expect(await probe(build(90_000, 90_000 * 11))).toMatchObject({ container, durationSec: 10 })
	})

	it("spans one 33-bit wrap", async () => {
		expect(await probe(build(PTS_WRAP - 90_000, 90_000))).toMatchObject({ container, durationSec: 2 })
	})

	it("leaves the duration unknown and the probe partial for a span of zero", async () => {
		expect(await probe(build(90_000, 90_000))).toMatchObject({ container, durationSec: null, partial: true })
	})

	it("leaves the duration unknown for a tail PTS more than half the clock before the first", async () => {
		expect(await probe(build(90_000 * 20, 90_000 * 10))).toMatchObject({ container, durationSec: null, partial: true })
	})
})
