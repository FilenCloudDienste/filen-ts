import { describe, expect, it, vi } from "vitest"
import { deflateSync } from "fflate"
import { decodeRle } from "@/features/preview/lib/dicom/rle.logic"
import {
	drawnSize,
	grayLut,
	modalityRange,
	paletteChannel,
	rangeWindow,
	renderColor,
	renderGray,
	renderPalette,
	storedValue,
	voi,
	type FrameSamples,
	type GrayModel
} from "@/features/preview/lib/dicom/pixels.logic"
import { FragmentIndex, nativeFrameBytes, nativeFrameSpan } from "@/features/preview/lib/dicom/frames.logic"
import { DicomInflateCapError, inflateDataset } from "@/features/preview/lib/dicom/inflate"
import { FrameCache } from "@/features/preview/lib/dicom/frameCache.logic"
import { FITTED, placement, zoomAt } from "@/features/preview/lib/dicom/view.logic"
import { stepFrame, dicomViewerKey } from "@/features/preview/lib/dicom/keys.logic"
import { transferSyntax } from "@/features/preview/lib/dicom/transferSyntax"
import { frameRequester, presetOf, windowFigure, windowPresets } from "@/features/preview/components/dicomViewer.logic"
import { pixelsWithin } from "@/lib/pixelBudget.logic"
import { dicomText } from "@/features/preview/lib/dicom/charset.logic"
import {
	DICOM_CODEC_INITIAL_HEAP,
	decoderCost,
	frameCost,
	framePixels,
	releasesHeap,
	type CostInput
} from "@/features/preview/lib/dicom/budget.logic"
import { encapsulated, frameOffsets, rleFrame } from "@/tests/support/dicomBytes"

// The DICOM viewer's pure parts: RLE, the pixel pipeline, frame offsets, the inflater, the view and its keys.

const GRAY16: GrayModel = { bitsStored: 12, signed: true, slope: 1, intercept: 0, voiFunction: "LINEAR", inverted: false }

function gray(data: Uint16Array | Uint8Array, rows: number, columns: number, shift = 0): FrameSamples {
	return { data, rows, columns, samplesPerPixel: 1, color: "gray", planar: false, shift }
}

describe("RLE (PS3.5 Annex G)", () => {
	it("unpacks literal and repeat runs into its byte plane", () => {
		// Literal 3 bytes, then 0x05 repeated 4 times, then a no-op (-128), then a literal of 1.
		const segment = [2, 1, 2, 3, 0xfd, 5, 0x80, 0, 9]
		const header = new Uint8Array(64)

		new DataView(header.buffer).setUint32(0, 1, true)
		new DataView(header.buffer).setUint32(4, 64, true)

		const decoded = decodeRle(Uint8Array.from([...header, ...segment]), { rows: 2, columns: 4, samplesPerPixel: 1, bytesPerSample: 1 })

		expect([...decoded]).toEqual([1, 2, 3, 5, 5, 5, 5, 9])
	})

	it("puts a 16-bit sample's high plane first, as little-endian samples", () => {
		const high = Uint8Array.from([0x01, 0xff])
		const low = Uint8Array.from([0x02, 0xfe])
		const decoded = decodeRle(rleFrame([high, low]), { rows: 1, columns: 2, samplesPerPixel: 1, bytesPerSample: 2 })

		expect([...new Uint16Array(decoded.buffer)]).toEqual([0x0102, 0xfffe])
	})

	it("interleaves colour samples and sizes its output from the tags alone", () => {
		const frame = rleFrame([Uint8Array.from([1, 2]), Uint8Array.from([3, 4]), Uint8Array.from([5, 6])])
		const decoded = decodeRle(frame, { rows: 1, columns: 2, samplesPerPixel: 3, bytesPerSample: 1 })

		expect([...decoded]).toEqual([1, 3, 5, 2, 4, 6])

		// A run longer than the frame stops at the frame's end.
		const header = new Uint8Array(64)

		new DataView(header.buffer).setUint32(0, 1, true)
		new DataView(header.buffer).setUint32(4, 64, true)

		const long = decodeRle(Uint8Array.from([...header, 0x81, 7]), { rows: 1, columns: 3, samplesPerPixel: 1, bytesPerSample: 1 })

		expect(long.length).toBe(3)
		expect([...long]).toEqual([7, 7, 7])
	})

	it("refuses a header whose segment count disagrees with the tags", () => {
		expect(() => decodeRle(rleFrame([Uint8Array.from([1])]), { rows: 1, columns: 1, samplesPerPixel: 1, bytesPerSample: 2 })).toThrow(
			/segments/
		)
	})
})

describe("the pixel pipeline", () => {
	it("masks Bits Stored below High Bit and sign-extends a signed 12-in-16 value", () => {
		// -5 in 12 bits, with garbage in the 4 bits above.
		expect(storedValue(0xfffb, 12, 0, true)).toBe(-5)
		expect(storedValue(0xaffb, 12, 0, true)).toBe(-5)
		expect(storedValue(0x07ff, 12, 0, true)).toBe(2047)
		expect(storedValue(0x0800, 12, 0, false)).toBe(2048)
		// Bits stored high in the container (High Bit 15).
		expect(storedValue(0xfff0, 12, 4, true)).toBe(-1)
	})

	it("applies the rescale and the window, and MONOCHROME1 inverts", () => {
		const samples = gray(Uint16Array.from([0xfffb, 0x0005, 0x07ff]), 1, 3)
		const range = modalityRange(samples, { ...GRAY16, slope: 2, intercept: 10 })

		expect(range).toEqual({ min: 0, max: 4104 })

		const window = { center: 0, width: 10 }
		const lut = grayLut(GRAY16, window, false)
		const out = new Uint8ClampedArray(12)

		renderGray(samples, GRAY16, window, false, lut, drawnSize(samples, 4096), out)
		expect([out[0], out[4], out[8]]).toEqual([0, 255, 255])

		const inverted = new Uint8ClampedArray(12)

		renderGray(
			samples,
			{ ...GRAY16, inverted: true },
			window,
			false,
			grayLut({ ...GRAY16, inverted: true }, window, false),
			drawnSize(samples, 4096),
			inverted
		)
		expect([inverted[0], inverted[4]]).toEqual([255, 0])
		// The viewer's Invert on top of MONOCHROME1 shows it upright again.
		expect(grayLut({ ...GRAY16, inverted: true }, window, true)[0x0ffb]).toBe(0)
	})

	it("draws the same levels per pixel when Bits Stored is too wide for a table", () => {
		const model: GrayModel = { ...GRAY16, bitsStored: 32, signed: false }
		const samples = { ...gray(new Uint8Array(0), 1, 2), data: Uint32Array.from([0, 100]) }
		const out = new Uint8ClampedArray(8)

		renderGray(samples, model, { center: 50, width: 100 }, false, null, drawnSize(samples, 4096), out)
		expect([out[0], out[4]]).toEqual([0, 255])
	})

	it("follows PS3.3's linear window at its edges", () => {
		expect(voi(39.5 - 199.5 - 1, { center: 40, width: 400 }, "LINEAR")).toBe(0)
		expect(voi(240, { center: 40, width: 400 }, "LINEAR")).toBe(255)
		expect(voi(40, { center: 40, width: 400 }, "LINEAR_EXACT")).toBe(127.5)
		expect(voi(40, { center: 40, width: 400 }, "SIGMOID")).toBe(127.5)
		expect(rangeWindow({ min: -1000, max: 1000 })).toEqual({ center: 0, width: 2001 })
	})

	it("converts YBR_FULL and YBR_FULL_422 and reads planar RGB", () => {
		const neutral: FrameSamples = {
			data: Uint8Array.from([128, 128, 128]),
			rows: 1,
			columns: 1,
			samplesPerPixel: 3,
			color: "ybrFull",
			planar: false,
			shift: 0
		}
		const out = new Uint8ClampedArray(4)

		renderColor(neutral, 8, false, drawnSize(neutral, 4096), out)
		expect([...out]).toEqual([128, 128, 128, 255])

		// Y1 Y2 Cb Cr: two grey pixels of different brightness.
		const pair: FrameSamples = {
			data: Uint8Array.from([50, 200, 128, 128]),
			rows: 1,
			columns: 2,
			samplesPerPixel: 3,
			color: "ybrFull422",
			planar: false,
			shift: 0
		}
		const two = new Uint8ClampedArray(8)

		renderColor(pair, 8, false, drawnSize(pair, 4096), two)
		expect([two[0], two[4]]).toEqual([50, 200])

		const planar: FrameSamples = {
			data: Uint8Array.from([10, 20, 30, 40, 50, 60]),
			rows: 1,
			columns: 2,
			samplesPerPixel: 3,
			color: "rgb",
			planar: true,
			shift: 0
		}
		const rgb = new Uint8ClampedArray(8)

		renderColor(planar, 8, true, drawnSize(planar, 4096), rgb)
		expect([...rgb]).toEqual([245, 225, 205, 255, 235, 215, 195, 255])
	})

	it("maps PALETTE COLOR through 16-bit and packed 8-bit tables", () => {
		const words = new Uint8Array(4)

		new DataView(words.buffer).setUint16(0, 0x1200, true)
		new DataView(words.buffer).setUint16(2, 0xff00, true)

		const red = paletteChannel([2, 0, 16], words, true)
		const green = paletteChannel([2, 0, 8], Uint8Array.from([7, 9]), true)

		expect(red === null ? null : [...red]).toEqual([0x12, 0xff])
		expect(green === null ? null : [...green]).toEqual([7, 9])

		const palette = {
			entries: 2,
			first: 10,
			red: Uint8Array.from([1, 2]),
			green: Uint8Array.from([3, 4]),
			blue: Uint8Array.from([5, 6])
		}
		const samples: FrameSamples = {
			data: Uint8Array.from([9, 11, 12]),
			rows: 1,
			columns: 3,
			samplesPerPixel: 1,
			color: "palette",
			planar: false,
			shift: 0
		}
		const out = new Uint8ClampedArray(12)

		renderPalette(samples, 8, false, palette, false, drawnSize(samples, 4096), out)
		expect([...out]).toEqual([1, 3, 5, 255, 2, 4, 6, 255, 2, 4, 6, 255])
	})

	it("samples a frame larger than the canvas down while converting it", () => {
		const samples = gray(new Uint16Array(9000 * 10), 10, 9000)

		expect(drawnSize(samples, 4096)).toEqual({ width: 3000, height: 4, step: 3 })
	})
})

describe("frames", () => {
	it("sizes native frames and refuses a value shorter than its frames", () => {
		expect(nativeFrameBytes({ rows: 2, columns: 3, samplesPerPixel: 1, bitsAllocated: 16, subsampled: false })).toBe(12)
		expect(nativeFrameBytes({ rows: 2, columns: 4, samplesPerPixel: 3, bitsAllocated: 8, subsampled: true })).toBe(16)
		expect(nativeFrameBytes({ rows: 2, columns: 3, samplesPerPixel: 1, bitsAllocated: 1, subsampled: false })).toBeNull()
		expect(nativeFrameSpan(100, 24, 12, 2, 1, 200)).toEqual({ offset: 112, length: 12 })
		expect(() => nativeFrameSpan(100, 20, 12, 2, 1, 200)).toThrow(/shorter/)
		expect(() => nativeFrameSpan(100, 24, 12, 2, 1, 110)).toThrow(/shorter/)
	})

	const fragments = [Uint8Array.from([0xff, 0xd8, 1, 2]), Uint8Array.from([3, 4]), Uint8Array.from([0xff, 0xd8, 5, 6])]

	function index(bytes: Uint8Array, frames: number, perFrame = false) {
		const read = vi.fn((offset: number, length: number) => bytes.subarray(offset, offset + length))

		return {
			read,
			fragments: new FragmentIndex({ read, start: 0, end: bytes.length, frames, fragmentPerFrame: perFrame, extendedOffsets: null })
		}
	}

	it("finds frames from the Basic Offset Table", () => {
		const parts = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5, 6])]
		const { fragments: found } = index(encapsulated(parts, frameOffsets(parts)), 2)

		expect(found.frame(1)).toEqual([{ offset: 8 + 8 + 8 + 2 + 8, length: 4 }])
	})

	it("walks item headers without a table: a codestream's start marker begins a frame", () => {
		const { fragments: found } = index(encapsulated(fragments), 2)

		expect(found.frame(0)).toEqual([
			{ offset: 16, length: 4 },
			{ offset: 28, length: 2 }
		])
		expect(found.frame(1)).toEqual([{ offset: 38, length: 4 }])
		expect(() => found.frame(2)).toThrow(/frame 2 of 2/)
	})

	it("takes one fragment a frame for RLE, and every fragment for a single frame", () => {
		expect(index(encapsulated(fragments), 3, true).fragments.frame(1)).toEqual([{ offset: 28, length: 2 }])
		expect(index(encapsulated(fragments), 1).fragments.frame(0)).toHaveLength(3)
	})

	it("reads no further than the frame asked for", () => {
		const { read, fragments: found } = index(encapsulated(fragments), 2)

		found.frame(0)

		// The table, then each item header and its first bytes up to the next frame's start.
		expect(Math.max(...read.mock.calls.map(([offset, length]) => offset + length))).toBeLessThanOrEqual(40)
	})

	it("refuses pixel data that does not begin with its offset table", () => {
		// A sequence delimiter where the table's item belongs; then no item header at all.
		expect(() => index(Uint8Array.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]), 1).fragments.frame(0)).toThrow(/offset table/)
		expect(() => index(new Uint8Array(16), 1).fragments.frame(0)).toThrow(/malformed/)
	})
})

describe("the inflater", () => {
	it("keeps the header bytes and inflates the rest after them", () => {
		const header = Uint8Array.from([1, 2, 3])
		const body = new TextEncoder().encode("a data set ".repeat(100))
		const file = Uint8Array.from([...header, ...deflateSync(body)])
		const out = inflateDataset(file, 3, body.length)

		expect([...out.subarray(0, 3)]).toEqual([1, 2, 3])
		expect(new TextDecoder().decode(out.subarray(3))).toBe("a data set ".repeat(100))
	})

	it("stops at the output cap, before the whole stream is inflated", () => {
		const body = new Uint8Array(4 * 1024 * 1024)
		const file = Uint8Array.from([9, ...deflateSync(body)])

		expect(() => inflateDataset(file, 1, 64 * 1024)).toThrow(DicomInflateCapError)
		expect(inflateDataset(file, 1, body.length).length).toBe(body.length + 1)
	})
})

describe("the view, keys and presets", () => {
	it("zooms about a point and keeps it under the pointer", () => {
		const canvas = { width: 800, height: 600 }
		const frame = { width: 512, height: 512 }
		const before = placement(canvas, frame, 1, FITTED)
		const zoomed = zoomAt(FITTED, 2, canvas, 100, 100)
		const after = placement(canvas, frame, 1, zoomed)
		const u = (100 - before.x) / before.width
		const v = (100 - before.y) / before.height

		expect(after.x + u * after.width).toBeCloseTo(100)
		expect(after.y + v * after.height).toBeCloseTo(100)
	})

	it("steps frames with Page Down and Page Up, holding at the ends", () => {
		const event = (key: string) => ({
			key,
			code: key,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			getModifierState: () => false
		})

		expect(dicomViewerKey(event("PageDown"), {}, false)).toBe("preview.dicomNextFrame")
		expect(dicomViewerKey(event("PageUp"), {}, false)).toBe("preview.dicomPreviousFrame")
		expect(dicomViewerKey(event("PageUp"), { "preview.dicomPreviousFrame": "" }, false)).toBeUndefined()
		expect(stepFrame(0, 3, "preview.dicomPreviousFrame")).toBe(0)
		expect(stepFrame(2, 3, "preview.dicomNextFrame")).toBe(2)
		expect(stepFrame(1, 3, "preview.dicomNextFrame")).toBe(2)
	})

	it("offers the file's windows and, for CT, the usual presets", () => {
		const windows = [
			{ center: 40, width: 400, explanation: null },
			{ center: 300, width: 1500, explanation: "BONE" }
		]
		const presets = windowPresets({ windows, hounsfield: true })

		expect(presets.map(preset => (preset.kind === "ct" ? preset.id : preset.kind))).toEqual([
			"default",
			"file",
			"softTissue",
			"lung",
			"bone",
			"brain",
			"liver",
			"mediastinum"
		])
		expect(presetOf(presets, { center: -600, width: 1500 }, false)).toMatchObject({ kind: "ct", id: "lung" })
		expect(presetOf(presets, { center: 1, width: 2 }, false)).toBeNull()
		expect(presetOf(presets, { center: 1, width: 2 }, true)).toEqual({ kind: "default" })
		expect(windowPresets({ windows, hounsfield: false })).toHaveLength(2)
		expect([windowFigure(400), windowFigure(-600.4), windowFigure(2.345), windowFigure(0.5)]).toEqual(["400", "-600", "2.3", "0.5"])
	})

	it("sends one frame request at a time, the latest waiting", async () => {
		const shown: number[] = []
		const pending: (() => void)[] = []
		const request = frameRequester(
			frame =>
				new Promise<string>(resolve => {
					shown.push(frame)
					pending.push(() => {
						resolve("ok")
					})
				}),
			() => undefined
		)

		request(1)
		request(2)
		request(3)
		expect(shown).toEqual([1])
		pending.shift()?.()
		await Promise.resolve()
		await Promise.resolve()
		expect(shown).toEqual([1, 3])
	})
})

describe("the frame cache and budget", () => {
	it("keeps the frames ahead of a cine loop longer than it, rather than the ones just shown", () => {
		// 10 frames looped three times, room for 8: the frames furthest from being shown again go first.
		const cache = new FrameCache<number>(8)
		let hits = 0

		for (let step = 0; step < 30; step++) {
			const frame = step % 10

			cache.anchor(frame, 10, true)

			if (cache.has(frame)) hits++
			else cache.set(frame, frame, 1)
		}

		// Every loop after the first finds all but the frames the cache cannot hold (an LRU finds none).
		expect(hits).toBeGreaterThanOrEqual(2 * 7)
		expect(cache.bytes).toBe(8)
	})

	it("keeps the frames nearest the one on screen while stepping, and nothing past its cap", () => {
		const cache = new FrameCache<string>(3)

		for (const frame of [0, 1, 2, 3, 4]) {
			cache.anchor(frame, 10, false)
			cache.set(frame, String(frame), 1)
		}

		expect([0, 1, 2, 3, 4].filter(frame => cache.has(frame))).toEqual([2, 3, 4])

		// Back to frame 1: frame 4 is the furthest, and goes for it.
		cache.anchor(1, 10, false)
		expect(cache.keeps(1, 1)).toBe(true)
		cache.set(1, "1", 1)
		expect([1, 2, 3, 4].filter(frame => cache.has(frame))).toEqual([1, 2, 3])
		// Further than every frame kept: not kept.
		expect(cache.keeps(9, 1)).toBe(false)
		cache.set(9, "9", 1)
		expect(cache.has(9)).toBe(false)

		cache.set(5, "huge", 4)
		expect(cache.get(5)).toBeUndefined()
	})

	it("works out the pixels left once the file is held", () => {
		expect(pixelsWithin(1000, 200, 10)).toBe(80)
		expect(pixelsWithin(100, 200, 10)).toBe(0)
	})

	it("counts each decoder's working set, the encoded frame twice and the codec's grown heap", () => {
		const MIB = 1024 * 1024
		const DRAWN = 4096 * 4096
		const input = (decoder: CostInput["decoder"], samplesPerPixel: number, sampleBytes: number): CostInput => ({
			decoder,
			samplesPerPixel,
			sampleBytes,
			samplesInPlace: false,
			encodedInPlace: false,
			gray: samplesPerPixel === 1
		})
		const mobile = (cost: ReturnType<typeof decoderCost>, heap: number, encodedBytes = 0) =>
			framePixels(cost, { decodeBytes: 384 * MIB, held: 0, heap, encodedBytes, drawnPixels: DRAWN })

		// OpenJPEG: an int32 a sample twice and the decoded sample in wasm; the samples copied out and the RGBA drawn.
		const colour = decoderCost(input("jpeg2000", 3, 1))
		const grey = decoderCost(input("jpeg2000", 1, 2))

		expect([colour.js, colour.wasm, colour.encodedJs + colour.encodedWasm]).toEqual([3, 27, 2])
		expect(mobile(colour, DICOM_CODEC_INITIAL_HEAP)).toBe(Math.floor((384 * MIB) / 38))
		// Past the backing side squared, the RGBA drawn stops growing.
		expect(mobile(grey, DICOM_CODEC_INITIAL_HEAP)).toBe(Math.floor((384 * MIB - 8 * DRAWN) / 12))

		// The encoded frame costs twice its size; OpenJPH keeps about twice more of it.
		expect(mobile(grey, 0, 10 * MIB)).toBe(Math.floor((364 * MIB - 8 * DRAWN) / 12))
		expect(decoderCost(input("htj2k", 1, 2)).encodedWasm).toBe(3)

		// A heap grown past what the frame needs is held whole: only the JS side is left to the frame.
		const grownHeap = 300 * MIB
		const pixels = mobile(grey, grownHeap)

		expect(
			frameCost(grey, { decodeBytes: 0, held: 0, heap: grownHeap, encodedBytes: 0, drawnPixels: DRAWN }, pixels)
		).toBeLessThanOrEqual(384 * MIB)
		expect(pixels).toBe(Math.floor((84 * MIB) / 10))

		// 32-bit colour, native: 12 bytes of samples and the RGBA drawn.
		expect(decoderCost(input("native", 3, 4)).js).toBe(12)
		expect(decoderCost({ ...input("native", 1, 2), samplesInPlace: true, encodedInPlace: true })).toMatchObject({ js: 0, encodedJs: 0 })

		// Nothing left once the encoded frame is held.
		expect(framePixels(grey, { decodeBytes: 100, held: 0, heap: 0, encodedBytes: 60, drawnPixels: DRAWN })).toBe(0)
	})

	it("lets a codec's heap go once it is past 256 MiB and twice the next frame's need, unless cine is playing", () => {
		const MIB = 1024 * 1024

		expect(releasesHeap(300 * MIB, 100 * MIB, false)).toBe(true)
		expect(releasesHeap(300 * MIB, 100 * MIB, true)).toBe(false)
		expect(releasesHeap(300 * MIB, 200 * MIB, false)).toBe(false)
		expect(releasesHeap(200 * MIB, 10 * MIB, false)).toBe(false)
	})

	it("knows the transfer syntaxes it decodes, a padded UID included", () => {
		expect(transferSyntax("1.2.840.10008.1.2.1\0")).toMatchObject({ decoder: "native", explicitVr: true })
		expect(transferSyntax("1.2.840.10008.1.2.1.99")).toMatchObject({ deflated: true })
		expect(transferSyntax("1.2.840.10008.1.2.4.201")).toMatchObject({ decoder: "htj2k", encapsulated: true })
		expect(transferSyntax("1.2.840.10008.1.2.4.100")).toBeNull()
	})
})

describe("Specific Character Set", () => {
	const ESC = 0x1b
	const bytes = (...parts: (string | number[])[]) =>
		Uint8Array.from(parts.flatMap(part => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)))

	it("reads ISO 2022 code extensions, switching sets at escapes and back at each delimiter (PS3.5 H, I, K)", () => {
		// Japanese: JIS X 0208 escaped into G0.
		const japanese = bytes(
			"Yamada^Tarou=",
			[ESC, 0x24, 0x42, 0x3b, 0x33, 0x45, 0x44, ESC, 0x28, 0x42],
			"^",
			[ESC, 0x24, 0x42, 0x42, 0x40, 0x4f, 0x3a, ESC, 0x28, 0x42],
			"=",
			[ESC, 0x24, 0x42, 0x24, 0x64, 0x24, 0x5e, 0x24, 0x40, ESC, 0x28, 0x42],
			"^",
			[ESC, 0x24, 0x42, 0x24, 0x3f, 0x24, 0x6d, 0x24, 0x26, ESC, 0x28, 0x42]
		)

		expect(dicomText("\\ISO 2022 IR 87").decode(japanese, "PN")).toBe("Yamada^Tarou=山田^太郎=やまだ^たろう")

		// Korean: KS X 1001 designated to G1, again after each delimiter.
		const korean = bytes(
			"Hong^Gildong=",
			[ESC, 0x24, 0x29, 0x43, 0xfb, 0xf3],
			"^",
			[ESC, 0x24, 0x29, 0x43, 0xd1, 0xce, 0xd4, 0xd7],
			"=",
			[ESC, 0x24, 0x29, 0x43, 0xc8, 0xab],
			"^",
			[ESC, 0x24, 0x29, 0x43, 0xb1, 0xe6, 0xb5, 0xbf]
		)

		expect(dicomText("\\ISO 2022 IR 149").decode(korean, "PN")).toBe("Hong^Gildong=洪^吉洞=홍^길동")

		// Chinese: GB 2312 in G1.
		const chinese = bytes(
			"Zhang^XiaoDong=",
			[ESC, 0x24, 0x29, 0x41, 0xd5, 0xc5],
			"^",
			[ESC, 0x24, 0x29, 0x41, 0xd0, 0xa1, 0xb6, 0xab],
			"="
		)

		expect(dicomText("ISO 2022 IR 6\\ISO 2022 IR 58").decode(chinese, "PN")).toBe("Zhang^XiaoDong=张^小东=")

		// JIS X 0212 and half-width katakana in G1 from the first term.
		expect(dicomText("\\ISO 2022 IR 159").decode(bytes([ESC, 0x24, 0x28, 0x44, 0x2b, 0x21, ESC, 0x28, 0x42]), "LO")).toBe("á")
		expect(dicomText("ISO 2022 IR 13\\ISO 2022 IR 87").decode(bytes([0xd4, 0xcf, 0xc0, 0xde]), "PN")).toBe("ﾔﾏﾀﾞ")
		expect(dicomText("ISO 2022 IR 100").decode(bytes("M", [0xfc], "ller"), "PN")).toBe("Müller")
	})

	it("reads one set for the whole value without extensions, and Latin-1 only when nothing else reads it", () => {
		expect(dicomText("ISO_IR 144").decode(bytes([0xbf, 0xe0, 0xd8, 0xd2, 0xd5, 0xe2]), "LO")).toBe("Привет")
		expect(dicomText("ISO_IR 192").decode(bytes("Zoë"), "PN")).toBe("Zoë")
		// Unknown, or nothing declared: UTF-8 when the bytes are UTF-8, else Latin-1.
		expect(dicomText("ISO_IR 999").decode(bytes("Zoë"), "PN")).toBe("Zoë")
		expect(dicomText(undefined).decode(bytes("M", [0xfc], "ller"), "PN")).toBe("Müller")
		// A code string is the default repertoire whatever is declared.
		expect(dicomText("ISO_IR 192").decode(bytes("ORIGINAL"), "CS")).toBe("ORIGINAL")
	})
})
