import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CustomSource, EncodedPacketSink, Input, type InputFormat } from "mediabunny"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { AVI, KeyIndexBuilder } from "@/lib/media/demux/aviDemuxer"
import { FLV } from "@/lib/media/demux/flvDemuxer"

// Real files with one header size made hostile, served as the head of a 2 GiB file: opening and reading them stays
// within the probe's own read budget instead of fetching what the header claims.
const VIRTUAL_SIZE = 2 * 1024 ** 3
const READ_BUDGET = 8 * 1024 * 1024
const FIXTURES = join(__dirname, "fixtures", "demux")

function patched(name: string, at: (bytes: Uint8Array) => number, value: number, width: number): Uint8Array {
	const bytes = Uint8Array.from(readFileSync(join(FIXTURES, name)))
	const offset = at(bytes)

	for (let i = 0; i < width; i++) {
		bytes[offset + i] = Math.floor(value / 256 ** i) & 0xff
	}

	return bytes
}

function indexOfBytes(bytes: Uint8Array, needle: readonly number[]): number {
	for (let at = 0; at + needle.length <= bytes.length; at++) {
		if (needle.every((byte, i) => bytes[at + i] === byte)) {
			return at
		}
	}

	throw new Error("not found")
}

async function bytesRead(format: InputFormat, head: Uint8Array): Promise<number> {
	let total = 0
	const input = new Input({
		formats: [format],
		source: new CustomSource({
			getSize: () => VIRTUAL_SIZE,
			read: (start, end) => {
				total += end - start

				const out = new Uint8Array(end - start)

				out.set(head.subarray(Math.min(start, head.length), Math.min(end, head.length)))

				return out
			},
			maxCacheSize: 0,
			prefetchProfile: "none"
		})
	})

	for (const track of await input.getTracks().catch(() => [])) {
		const sink = new EncodedPacketSink(track)

		await sink.getFirstPacket().catch(() => null)
	}

	return total
}

// The File Properties object's GUID, as stored.
const ASF_FILE_PROPERTIES = [0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65]

describe("demuxers over hostile header sizes", () => {
	it("AVI: an hdrl list claiming gigabytes", async () => {
		const bytes = patched("h264-bframes-mp3.avi", () => 16, 0x7ffffff0, 4)

		expect(await bytesRead(AVI, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("ASF: a header object claiming gigabytes", async () => {
		const bytes = patched("h264-mp3.asf", () => 16, 0x7ffffff0, 8)

		expect(await bytesRead(ASF, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("ASF: a data packet size of a gigabyte", async () => {
		const bytes = patched("h264-mp3.asf", found => indexOfBytes(found, ASF_FILE_PROPERTIES) + 68, 0x4000_0000 * 0x1_0000_0001, 8)

		expect(await bytesRead(ASF, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("FLV: a DataOffset past the head", async () => {
		const header = Uint8Array.from([0x46, 0x4c, 0x56, 1, 0x05, 0x7f, 0xff, 0xff, 0xf0, 0, 0, 0, 0])

		expect(await bytesRead(FLV, header)).toBeLessThan(READ_BUDGET)
	})
})

describe("AVI key index", () => {
	it("keeps one position a second at most, thinning past its cap, with the ticks of those positions only", () => {
		const builder = new KeyIndexBuilder(32)
		const ticks = Array.from({ length: 32 }, () => 0)

		// Six hours of all-intra pictures at 25 fps.
		for (let frame = 0; frame < 25 * 3600 * 6; frame++) {
			ticks[0] = frame
			builder.add(frame * 1000, frame / 25, ticks)
		}

		const index = defined(builder.build())
		const entries = index.positions.length

		expect(entries).toBeLessThanOrEqual(8192)
		expect(index.ticks.length).toBe(entries * 32)
		expect(index.ticks[32]).toBeGreaterThanOrEqual(25)
		expect((index.positions[1] ?? 0) - (index.positions[0] ?? 0)).toBeGreaterThanOrEqual(25 * 1000)
	})
})

function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("missing")
	}

	return value
}
