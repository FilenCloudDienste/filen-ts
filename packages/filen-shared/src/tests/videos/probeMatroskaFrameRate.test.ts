import { describe, expect, it } from "vitest"
import { BlockSource, bytesReadRange, parseEdl, parseSubtitle, probeVideo, type VideoProbe } from "@filen/shared/videos"

// The picture track's frame rate, read from Matroska's DefaultDuration, times frame-based subtitles and .edl entries.

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
	const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
	const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of arrays) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

function ebmlId(id: number): number[] {
	const bytes: number[] = []

	for (let value = id; value > 0; value = Math.floor(value / 256)) {
		bytes.unshift(value & 0xff)
	}

	return bytes
}

// A 4-byte size: marker bit 0x10 in the first byte.
function element(id: number, ...payload: (Uint8Array | number[])[]): Uint8Array {
	const body = concat(...payload)

	return concat(
		ebmlId(id),
		[0x10 | ((body.length >>> 24) & 0x0f), (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff],
		body
	)
}

function uintElement(id: number, value: number): Uint8Array {
	const bytes: number[] = []

	for (let rest = value; bytes.length === 0 || rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256)
	}

	return element(id, bytes)
}

function stringElement(id: number, value: string): Uint8Array {
	return element(id, [...new TextEncoder().encode(value)])
}

function mkv(...videoFields: Uint8Array[]): Uint8Array {
	const duration = new Uint8Array(8)

	new DataView(duration.buffer).setFloat64(0, 60_000)

	return concat(
		element(0x1a45dfa3, stringElement(0x4282, "matroska")),
		concat(
			[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
			element(0x1549a966, uintElement(0x2ad7b1, 1_000_000), element(0x4489, duration)),
			element(
				0x1654ae6b,
				element(
					0xae,
					uintElement(0xd7, 1),
					uintElement(0x83, 1),
					stringElement(0x86, "V_VP8"),
					...videoFields,
					element(0xe0, uintElement(0xb0, 640), uintElement(0xba, 360))
				)
			)
		)
	)
}

async function probe(bytes: Uint8Array): Promise<VideoProbe | null> {
	return probeVideo(new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 4 }), "card")
}

describe("Matroska frame rate", () => {
	it("reads the picture track's DefaultDuration as frames per second", async () => {
		expect((await probe(mkv(uintElement(0x23e383, 40_000_000))))?.video?.fps).toBe(25)
		expect((await probe(mkv(uintElement(0x23e383, 41_708_333))))?.video?.fps).toBeCloseTo(23.976, 3)
	})

	it("leaves the rate out when the track states none, or a broken one", async () => {
		expect((await probe(mkv()))?.video).not.toHaveProperty("fps")
		expect((await probe(mkv(uintElement(0x23e383, 0))))?.video).not.toHaveProperty("fps")
		expect((await probe(mkv(uintElement(0x23e383, 10))))?.video).not.toHaveProperty("fps")
	})

	it("times a header-less MicroDVD file and a frame-based .edl by the probed rate", async () => {
		const fps = (await probe(mkv(uintElement(0x23e383, 40_000_000))))?.video?.fps

		if (fps === undefined) {
			throw new Error("no frame rate probed")
		}

		expect(parseSubtitle("{90000}{90050}Late\n", "sub", { fps })?.starts[0]).toBe(3600)
		expect(parseEdl("#1500 #3000 0\n", fps)).toEqual([{ kind: "commercial", start: 60, end: 120, source: "edl", mustSkip: true }])
	})
})
