import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	declaredPixels,
	endsCodestream,
	jpeg2000Header,
	jpegFrameHeader,
	jpegLsHeader,
	losslessJpegHeader,
	matchesTags,
	reducedSize,
	reductionWithin,
	withoutExif
} from "@/features/preview/lib/dicom/codestream.logic"
import type { PixelModule } from "@/features/preview/lib/dicom/pixelModule"
import { losslessJpeg, siz } from "@/tests/support/dicomBytes"

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
// OpenJPH, each module it loads kept, for a look at how its decoder is called.
const openjphModules = vi.hoisted((): { HTJ2KDecoder: { prototype: { decodeSubResolution: (...levels: number[]) => void } } }[] => [])

vi.mock("@cornerstonejs/codec-openjph/wasmjs", async importOriginal => {
	const actual = await importOriginal<{ default: (options: object) => Promise<(typeof openjphModules)[number]> }>()

	return {
		default: async (options: object) => {
			const loaded = await actual.default(options)

			openjphModules.push(loaded)

			return loaded
		}
	}
})

// The decode-only CharLS build, each module it loads kept: a module loaded afresh is one more.
const charlsModules = vi.hoisted((): { JpegLSDecoder: { prototype: { decode: () => void } } }[] => [])

vi.mock("@cornerstonejs/codec-charls/decodewasmjs", async importOriginal => {
	const actual = await importOriginal<{ default: (options: object) => Promise<(typeof charlsModules)[number]> }>()

	return {
		default: async (options: object) => {
			const loaded = await actual.default(options)

			charlsModules.push(loaded)

			return loaded
		}
	}
})

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

const TAGS = { rows: 48, columns: 64, samplesPerPixel: 1, bitsAllocated: 16, bitsStored: 16 }

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

	it("cuts a JPEG's Exif segments, and their orientation, out before the browser decodes it", () => {
		const ascii = (text: string) => [...new TextEncoder().encode(text)]
		// APP1 "Exif\0\0" with an orientation tag (6: rotate 90°), and an XMP APP1, which stays.
		const exif = [0xff, 0xe1, 0, 18, ...ascii("Exif"), 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0x01, 0x12]
		const xmp = [0xff, 0xe1, 0, 6, ...ascii("http")]
		const plainJpeg = jpeg(0xc0, 8, 48, 64, 1)
		const withExif = jpeg(0xc0, 8, 48, 64, 1, [...exif, ...xmp])
		const cut = withoutExif(withExif)

		expect([...cut]).toEqual([...jpeg(0xc0, 8, 48, 64, 1, xmp)])
		expect(jpegFrameHeader(cut)).toEqual(jpegFrameHeader(withExif))
		expect(withoutExif(plainJpeg)).toBe(plainJpeg)
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
		expect(jpeg2000Header(siz(64, 48, 3, 12, 5))).toEqual({
			rows: 48,
			columns: 64,
			components: 3,
			bits: 12,
			levels: 5,
			x0: 0,
			y0: 0,
			tiles: 1,
			codeBlock: 64
		})
		expect(jpeg2000Header(siz(64, 48, 3, 8, 5, { subsampled: true }))).toBeNull()

		// One-pixel tiles over a large image: more tiles than a codestream can index.
		const tiny = siz(4096, 4096, 1, 8, 5)

		tiny.set([0, 0, 0, 1, 0, 0, 0, 1], 24)
		expect(jpeg2000Header(tiny)).toBeNull()
		expect(jpeg2000Header(siz(64, 48, 1, 8, 5).subarray(0, 50))).toBeNull()
		expect(jpeg2000Header(Uint8Array.from([0xff, 0xd8]))).toBeNull()
	})

	it("matches the header to the tags, either way, and checks the larger against the budget", () => {
		const header = { rows: 48, columns: 64, components: 1, bits: 16, levels: 0, x0: 0, y0: 0 }

		expect(matchesTags(header, TAGS)).toBe(true)
		expect(matchesTags({ ...header, rows: 4800 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, rows: 47 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, components: 3 }, TAGS)).toBe(false)
		expect(matchesTags({ ...header, bits: 12 }, TAGS)).toBe(false)
		// A precision past Bits Stored, within Bits Allocated, is the standard's own allowance.
		expect(matchesTags(header, { ...TAGS, bitsStored: 12 })).toBe(true)
		expect(matchesTags({ ...header, bits: 8 }, { ...TAGS, bitsAllocated: 8, bitsStored: 8 })).toBe(true)
		expect(matchesTags({ ...header, bits: 12 }, { ...TAGS, bitsAllocated: 8, bitsStored: 8 })).toBe(false)
		expect(declaredPixels({ ...header, rows: 4800 }, TAGS)).toBe(4800 * 64)
	})

	it("takes the fewest decomposition levels any component or tile part codes with", () => {
		expect(jpeg2000Header(siz(64, 48, 3, 8, 5, { componentLevels: [{ component: 2, levels: 2 }] }))?.levels).toBe(2)

		// The main header ends at its SOT marker; a tile part follows with its own COD of one level, then a second.
		const main = siz(64, 48, 1, 8, 5)
		const tilePart = (levels: number | null): number[] => {
			const cod = levels === null ? [] : [0xff, 0x52, 0, 12, 0, 0, 0, 1, 0, levels, 4, 4, 0, 0]
			const body = [0xff, 0x93, 1, 2, 3, 4]
			const length = 12 + cod.length + body.length

			// Lsot, Isot, Psot, TPsot, TNsot: the SOT marker's own two bytes are the main header's (or the part before).
			return [0, 10, 0, 0, 0, 0, 0, length, 0, 1, ...cod, ...body]
		}
		const stream = Uint8Array.from([...main, ...tilePart(null), 0xff, 0x90, ...tilePart(1), 0xff, 0xd9])

		expect(jpeg2000Header(stream)?.levels).toBe(1)
		expect(jpeg2000Header(Uint8Array.from([...main, ...tilePart(null), 0xff, 0xd9]))?.levels).toBe(5)
	})

	it("sizes a reduced resolution from the image's origin on the reference grid, as the decoders do", () => {
		const header = jpeg2000Header(siz(101, 7, 1, 8, 3, { x0: 1, y0: 3 }))

		if (header === null) throw new Error("no header")

		expect(header).toMatchObject({ columns: 101, rows: 7, x0: 1, y0: 3 })
		// ceil(102 / 2) − ceil(1 / 2) and ceil(10 / 2) − ceil(3 / 2): not ceil(101 / 2) and ceil(7 / 2).
		expect(reducedSize(header, 1)).toEqual({ columns: 50, rows: 3 })
		expect(reducedSize(header, 0)).toEqual({ columns: 101, rows: 7 })
		expect(reducedSize({ ...header, x0: 0, y0: 0 }, 1)).toEqual({ columns: 51, rows: 4 })
	})

	it("picks the fewest JPEG 2000 reductions that fit the budget", () => {
		const header = { rows: 1000, columns: 1000, components: 1, bits: 16, levels: 3, x0: 0, y0: 0 }

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

		// A 12-bit codestream for 10 bits stored.
		expect((await decodeCompressed(stream, grayModule(48, 64, 10), "gray", decoder, 10_000)).rows).toBe(48)
	})
	it("decodes a lossless JPEG through jpeg-lossless-decoder-js, as written by the tests' own encoder", async () => {
		const samples = Uint16Array.from({ length: 48 * 64 }, (_, i) => (i * 37) % 4096)
		const stream = losslessJpeg(samples, 64, 12)

		expect(losslessJpegHeader(stream)).toMatchObject({ rows: 48, columns: 64, components: 1, bits: 12 })

		const decoded = await decodeCompressed(stream, grayModule(48, 64, 12), "gray", "jpegLossless", 10_000)

		expect([...decoded.data]).toEqual([...samples])
		await expect(
			decodeCompressed(stream.slice(0, stream.length / 3), grayModule(48, 64, 12), "gray", "jpegLossless", 10_000)
		).rejects.toMatchObject({
			reason: "damaged"
		})
	})

	it("refuses a codestream in 4 × 4 code blocks itself, before OpenJPH sets aside 430 MiB for it", async () => {
		// The verification's hostile stream (src/tests/dicomFile.test.ts says how it was written).
		const stream = new Uint8Array(readFileSync(join(__dirname, "fixtures", "dicom", "ht-cb4.j2c")))
		const tags = { ...grayModule(16, 16, 8), bitsAllocated: 8 }

		await expect(decodeCompressed(stream, tags, "gray", "htj2k", 10_000)).rejects.toMatchObject({ reason: "unsupported" })
		expect(openjphModules.every(loaded => (loaded as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength <= 50 * 1024 * 1024)).toBe(
			true
		)
	})

	it("asks OpenJPH for a reduced resolution by its decomposition levels alone, as its binding takes them", async () => {
		const info = { width: 64, height: 48, bitsPerSample: 12, componentCount: 1, isSigned: false, isUsingColorTransform: false }
		const stream = await encoder("@cornerstonejs/codec-openjph/wasmjs", "HTJ2KEncoder", info, ramp, 3)

		await decodeCompressed(stream, grayModule(48, 64, 12), "gray", "htj2k", 10_000)

		const loaded = openjphModules.at(-1)

		if (loaded === undefined) throw new Error("OpenJPH never loaded")

		const reduce = vi.spyOn(loaded.HTJ2KDecoder.prototype, "decodeSubResolution")

		await decodeCompressed(stream, grayModule(48, 64, 12), "gray", "htj2k", 32 * 24)
		expect(reduce.mock.calls).toEqual([[1]])
	})

	it.each([
		["jpeg2000", "@cornerstonejs/codec-openjpeg/wasmjs", "J2KEncoder"],
		["htj2k", "@cornerstonejs/codec-openjph/wasmjs", "HTJ2KEncoder"]
	] as const)("calls a %s frame cut short or corrupt damaged, never a mismatch", async (decoder, name, entry) => {
		const info = { width: 64, height: 48, bitsPerSample: 12, componentCount: 1, isSigned: false, isUsingColorTransform: false }
		const stream = await encoder(name, entry, info, ramp, 3)
		const tags = grayModule(48, 64, 12)

		expect(endsCodestream(stream)).toBe(true)
		expect(endsCodestream(Uint8Array.from([...stream, 0]))).toBe(true)

		for (const kept of [0.5, 0.2]) {
			await expect(
				decodeCompressed(stream.slice(0, Math.floor(stream.length * kept)), tags, "gray", decoder, 10_000)
			).rejects.toMatchObject({
				reason: "damaged"
			})
		}

		// Its packets overwritten, its end marker kept: the decoder's own failure where it reports one, never a mismatch.
		const corrupt = stream.slice()

		corrupt.fill(0xff, Math.floor(stream.length / 2), stream.length - 2)

		const outcome = await decodeCompressed(corrupt, tags, "gray", decoder, 10_000).then(
			() => "decoded",
			(error: unknown) => (error as { reason?: string }).reason
		)

		expect(outcome).not.toBe("mismatch")
	})

	it("keeps CharLS loaded through a stream it throws on, and loads it afresh only after an abort", async () => {
		const info = { width: 64, height: 48, bitsPerSample: 12, componentCount: 1 }
		const jls = await encoder("@cornerstonejs/codec-charls/wasmjs", "JpegLSEncoder", info, ramp)
		const tags = grayModule(48, 64, 12)

		await decodeCompressed(jls, tags, "gray", "jpegLs", 10_000)

		const loads = charlsModules.length

		await expect(decodeCompressed(jls.slice(0, jls.length / 2), tags, "gray", "jpegLs", 10_000)).rejects.toMatchObject({
			reason: "damaged"
		})
		await decodeCompressed(jls, tags, "gray", "jpegLs", 10_000)
		expect(charlsModules).toHaveLength(loads)

		const loaded = charlsModules.at(-1)

		if (loaded === undefined) throw new Error("CharLS never loaded")

		const abort = vi.spyOn(loaded.JpegLSDecoder.prototype, "decode").mockImplementationOnce(() => {
			throw new WebAssembly.RuntimeError("unreachable")
		})

		await expect(decodeCompressed(jls, tags, "gray", "jpegLs", 10_000)).rejects.toMatchObject({ reason: "damaged" })
		abort.mockRestore()
		await decodeCompressed(jls, tags, "gray", "jpegLs", 10_000)
		expect(charlsModules).toHaveLength(loads + 1)
	})
})
