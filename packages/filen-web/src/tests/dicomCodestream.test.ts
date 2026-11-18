import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"
import {
	declaredPixels,
	jpeg2000Header,
	jpegFrameHeader,
	jpegLsHeader,
	losslessJpegHeader,
	matchesTags,
	reductionWithin
} from "@/features/preview/lib/dicom/codestream.logic"
import type { PixelModule } from "@/features/preview/lib/dicom/pixelModule"

// The codestream header checks made before a compressed DICOM frame reaches its decoder, and the decoders themselves
// (CharLS, OpenJPEG, OpenJPH) on codestreams their own encoders wrote.

// The wasm files from the packages themselves: Emscripten reads a path with fs under node.
const paths = vi.hoisted(async () => {
	const { createRequire: requireFrom } = await import("node:module")
	const resolve = requireFrom(import.meta.url).resolve

	return {
		charls: resolve("@cornerstonejs/codec-charls/decodewasm"),
		openjpeg: resolve("@cornerstonejs/codec-openjpeg/decodewasm"),
		openjph: resolve("@cornerstonejs/codec-openjph/wasm")
	}
})

vi.mock("@cornerstonejs/codec-charls/decodewasm?url", async () => ({ default: (await paths).charls }))
vi.mock("@cornerstonejs/codec-openjpeg/decodewasm?url", async () => ({ default: (await paths).openjpeg }))
vi.mock("@cornerstonejs/codec-openjph/wasm?url", async () => ({ default: (await paths).openjph }))

const { decodeCompressed } = await import("@/features/preview/lib/dicom/codecs")

const be16 = (value: number) => [value >> 8, value & 0xff]

// SOI, the segments in `before`, SOFn, then SOS.
function jpeg(sof: number, precision: number, rows: number, columns: number, components: number, before: number[] = []): Uint8Array {
	return Uint8Array.from([
		0xff,
		0xd8,
		...before,
		0xff,
		sof,
		...be16(8 + components * 3),
		precision,
		...be16(rows),
		...be16(columns),
		components,
		...Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat(),
		0xff,
		0xda,
		...be16(6 + components * 2),
		components,
		...Array.from({ length: components }, (_, i) => [i + 1, 0]).flat(),
		1,
		0,
		0
	])
}

function siz(columns: number, rows: number, components: number, depth: number, levels: number, subsampled = false): Uint8Array {
	const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

	return Uint8Array.from([
		0xff,
		0x4f,
		0xff,
		0x51,
		...be16(38 + components * 3),
		0,
		0,
		...be32(columns),
		...be32(rows),
		...be32(0),
		...be32(0),
		...be32(columns),
		...be32(rows),
		...be32(0),
		...be32(0),
		...be16(components),
		...Array.from({ length: components }, (_, i) => [depth - 1, subsampled && i > 0 ? 2 : 1, 1]).flat(),
		0xff,
		0x52,
		...be16(12),
		0,
		0,
		0,
		1,
		0,
		levels,
		4,
		4,
		0,
		0,
		0xff,
		0x90
	])
}

const TAGS = { rows: 48, columns: 64, samplesPerPixel: 1, bitsStored: 16 }

describe("codestream headers", () => {
	it("reads a JPEG's SOFn past APPn, a lossless one as the decoder walks it, and JPEG-LS's SOF55", () => {
		const app = [0xff, 0xe0, 0, 4, 1, 2]

		expect(jpegFrameHeader(jpeg(0xc0, 8, 48, 64, 3, app))).toMatchObject({ rows: 48, columns: 64, components: 3, bits: 8 })
		expect(losslessJpegHeader(jpeg(0xc3, 16, 48, 64, 1, app))).toMatchObject({ rows: 48, columns: 64, components: 1, bits: 16 })

		const ls = jpeg(0xf7, 12, 48, 64, 1)

		expect(jpegLsHeader(ls)).toMatchObject({ rows: 48, columns: 64, components: 1, bits: 12 })
		expect(jpegFrameHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
		expect(jpegFrameHeader(new Uint8Array(4))).toBeNull()
	})

	it("follows the lossless decoder where a marker's length is not skipped, not a generic walk", () => {
		// An unknown marker (0xFFF0): the decoder reads the next two bytes as the next marker. Here they are an SOF3 for
		// a huge image; a walk that skipped the segment by its "length" (0xFFC3) would land elsewhere.
		const hidden = Uint8Array.from([0xff, 0xd8, 0xff, 0xf0, ...jpeg(0xc3, 16, 60_000, 60_000, 1).subarray(2)])

		expect(losslessJpegHeader(hidden)).toMatchObject({ rows: 60_000, columns: 60_000 })
		// DRI must be four bytes, as the decoder requires.
		expect(losslessJpegHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xdd, 0, 5, 0, 0, ...jpeg(0xc3, 8, 1, 1, 1).subarray(2)]))).toBeNull()
		// Arithmetic coding, and a frame whose scan names another component count, are refused.
		expect(losslessJpegHeader(jpeg(0xcb, 8, 1, 1, 1))).toBeNull()

		const scanOfTwo = jpeg(0xc3, 8, 2, 2, 3)

		scanOfTwo[scanOfTwo.length - 3 - 6 - 1] = 2
		expect(losslessJpegHeader(scanOfTwo)).toBeNull()
	})

	it("refuses JPEG-LS oversize dimensions, which would replace SOF55's", () => {
		const lse = [0xff, 0xf8, 0, 11, 4, 2, 0, 1, 0, 0, 1, 0, 0]
		// SOI and SOF55 end at byte 15; the LSE follows, then SOS.
		const head = jpeg(0xf7, 8, 48, 64, 1).subarray(0, 15)
		const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0]

		expect(jpegLsHeader(Uint8Array.from([...head, ...sos]))).toMatchObject({ rows: 48 })
		expect(jpegLsHeader(Uint8Array.from([...head, ...lse, ...sos]))).toBeNull()
	})

	it("reads JPEG 2000's SIZ and COD, refusing subsampled components", () => {
		expect(jpeg2000Header(siz(64, 48, 3, 12, 5))).toEqual({ rows: 48, columns: 64, components: 3, bits: 12, levels: 5 })
		expect(jpeg2000Header(siz(64, 48, 3, 8, 5, true))).toBeNull()
		expect(jpeg2000Header(siz(64, 48, 1, 8, 5).subarray(0, 50))).toBeNull()
		expect(jpeg2000Header(Uint8Array.from([0xff, 0xd8]))).toBeNull()
	})

	it("matches the header to the tags, either way, and checks the larger against the budget", () => {
		const header = { rows: 48, columns: 64, components: 1, bits: 16, levels: 0 }

		expect(matchesTags(header, TAGS)).toBe(true)
		expect(matchesTags({ ...header, rows: 4800 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, rows: 47 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, components: 3 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, bits: 12 }, TAGS)).toBe(false)
		expect(declaredPixels({ ...header, rows: 4800 }, TAGS)).toBe(4800 * 64)
	})

	it("picks the fewest JPEG 2000 reductions that fit the budget", () => {
		const header = { rows: 1000, columns: 1000, components: 1, bits: 16, levels: 3 }

		expect(reductionWithin(header, 1_000_000)).toBe(0)
		expect(reductionWithin(header, 250_000)).toBe(1)
		expect(reductionWithin(header, 15_625)).toBe(3)
		expect(reductionWithin(header, 15_624)).toBeNull()
	})
})

const require = createRequire(import.meta.url)

interface Encoder {
	getDecodedBuffer(info: Record<string, unknown>): Uint8Array
	getEncodedBuffer(): Uint8Array
	setDecompositions?(levels: number): void
	encode(): void
}

async function encoder(name: string, entry: string, info: Record<string, unknown>, fill: (raw: Uint8Array) => void, levels?: number) {
	const factory = require(name) as (options: Record<string, unknown>) => Promise<Record<string, new () => Encoder>>
	const module = await factory({ print: () => undefined, printErr: () => undefined })
	const Encoder = module[entry]

	if (Encoder === undefined) throw new Error(`${name} has no ${entry}`)

	const instance = new Encoder()

	if (levels !== undefined) instance.setDecompositions?.(levels)

	fill(instance.getDecodedBuffer(info))
	instance.encode()

	return instance.getEncodedBuffer().slice()
}

function grayModule(rows: number, columns: number, bitsStored: number, signed = false): PixelModule {
	return {
		rows,
		columns,
		samplesPerPixel: 1,
		photometric: "MONOCHROME2",
		planar: false,
		bitsAllocated: 16,
		bitsStored,
		highBit: bitsStored - 1,
		signed,
		frames: 1,
		slope: 1,
		intercept: 0,
		windows: [],
		voiFunction: "LINEAR",
		palette: null,
		modality: null,
		frameTimeMs: null,
		pixelAspect: 1,
		pixelData: { offset: 0, length: -1 },
		extendedOffsets: null
	}
}

const ramp = (raw: Uint8Array) => {
	const view = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2)

	for (let i = 0; i < view.length; i++) view[i] = i % 4096
}

describe("the codecs", () => {
	it("decodes JPEG-LS through CharLS, and refuses a header the tags disagree with or the budget cannot hold", async () => {
		const info = { width: 64, height: 48, bitsPerSample: 12, componentCount: 1 }
		const jls = await encoder("@cornerstonejs/codec-charls/wasmjs", "JpegLSEncoder", info, ramp)
		const decoded = await decodeCompressed(jls, grayModule(48, 64, 12), "gray", "jpegLs", 10_000)

		expect(decoded.data).toBeInstanceOf(Uint16Array)
		expect([...decoded.data.subarray(0, 4)]).toEqual([0, 1, 2, 3])
		await expect(decodeCompressed(jls, grayModule(47, 64, 12), "gray", "jpegLs", 10_000)).rejects.toMatchObject({ reason: "mismatch" })
		await expect(decodeCompressed(jls, grayModule(48, 64, 12), "gray", "jpegLs", 100)).rejects.toMatchObject({ reason: "tooLarge" })
	})

	it.each([
		["jpeg2000", "@cornerstonejs/codec-openjpeg/wasmjs", "J2KEncoder"],
		["htj2k", "@cornerstonejs/codec-openjph/wasmjs", "HTJ2KEncoder"]
	] as const)("decodes %s, at a reduced resolution when the budget asks for it", async (decoder, name, entry) => {
		const info = { width: 64, height: 48, bitsPerSample: 12, componentCount: 1, isSigned: false, isUsingColorTransform: false }
		const stream = await encoder(name, entry, info, ramp, 3)
		const full = await decodeCompressed(stream, grayModule(48, 64, 12), "gray", decoder, 10_000)

		expect([full.rows, full.columns]).toEqual([48, 64])
		expect([...full.data.subarray(0, 3)]).toEqual([0, 1, 2])

		const reduced = await decodeCompressed(stream, grayModule(48, 64, 12), "gray", decoder, 32 * 24)

		expect([reduced.rows, reduced.columns, reduced.data.length]).toEqual([24, 32, 32 * 24])
		await expect(decodeCompressed(stream, grayModule(48, 64, 12), "gray", decoder, 10)).rejects.toMatchObject({ reason: "tooLarge" })
		await expect(decodeCompressed(stream, grayModule(48, 64, 16), "gray", decoder, 10_000)).rejects.toMatchObject({
			reason: "mismatch"
		})
	})
})
