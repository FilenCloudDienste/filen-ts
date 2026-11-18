import { describe, expect, it, vi } from "vitest"
import { DicomOpenError, headerCap, memorySource, readHeader, type DicomSource } from "@/features/preview/lib/dicom/dicomFile"
import { imageVerdict, readPixelModule } from "@/features/preview/lib/dicom/pixelModule"
import {
	DicomFrameFailure,
	encapsulatedFrame,
	fragmentIndex,
	nativeFrame,
	type FrameContext
} from "@/features/preview/lib/dicom/frameDecode"
import { tagLevel, textDecoderFor } from "@/features/preview/lib/dicom/tagTree"
import { DICOM_WHOLE_MAX_BYTES, type DicomDecoder } from "@/features/preview/lib/dicom/transferSyntax"
import {
	DEFLATED,
	EXPLICIT_BE,
	EXPLICIT_LE,
	IMPLICIT_LE,
	JPEG_BASELINE,
	RLE,
	binary,
	dicomFile,
	encapsulated,
	frameOffsets,
	grayModule,
	rleFrame,
	sequence,
	text,
	us
} from "@/tests/support/dicomBytes"

// A DICOM file's header read from a growing prefix, its Image Pixel module, its frames under the pixel budget and its
// tags, on files written from scratch.

const MIB = 1024 * 1024
const DECODE = 1024 * MIB
const DECODERS: ReadonlySet<DicomDecoder> = new Set(["native", "rle"])

// A 3×2 CT frame stored 12 bits in 16, signed, with a rescale to Hounsfield units.
function ctFile(syntax: string, extra: ReturnType<typeof text>[] = []): Uint8Array {
	const littleEndian = syntax !== EXPLICIT_BE
	const values = [-5, 0, 2047, -2048, 100, 7]
	const pixels = new Uint8Array(values.length * 2)
	const view = new DataView(pixels.buffer)

	values.forEach((value, i) => {
		view.setUint16(i * 2, value & 0xffff, littleEndian)
	})

	return dicomFile({
		transferSyntax: syntax,
		elements: [
			text(0x00080060, "CS", "CT"),
			text(0x00100010, "PN", "Doe^Jane"),
			...grayModule({ rows: 2, columns: 3, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: true }),
			text(0x00281050, "DS", "40\\300"),
			text(0x00281051, "DS", "400\\1500"),
			text(0x00281055, "LO", "SOFT\\BONE"),
			text(0x00281052, "DS", "-1024"),
			text(0x00281053, "DS", "1"),
			...extra
		],
		pixelData: pixels
	})
}

// Counts how far into the file reads reach.
function counting(bytes: Uint8Array, size = bytes.length): DicomSource & { reach: () => number } {
	let furthest = 0

	return {
		size,
		read: (offset, length) => {
			furthest = Math.max(furthest, offset + length)

			if (offset + length > bytes.length) throw new DicomOpenError("unreadable", "past the test bytes")

			return bytes.slice(offset, offset + length)
		},
		reach: () => furthest
	}
}

function context(file: Uint8Array, decodeBytes = DECODE): { context: FrameContext; source: ReturnType<typeof counting> } {
	const source = counting(file)
	const header = readHeader(source, { decodeBytes })
	const module = readPixelModule(header.dataSet, header.syntax?.littleEndian ?? true)
	const verdict = imageVerdict(module, header.syntax, DECODERS)

	if (verdict.status !== "ok" || header.syntax === null) throw new Error(`not drawable: ${verdict.status}`)

	return {
		source,
		context: {
			module,
			syntax: header.syntax,
			color: verdict.color,
			source: header.pixels,
			budget: { decodeBytes, heldWith: frameBytes => (header.heldBytes > 0 ? header.heldBytes : frameBytes) },
			compressed: null
		}
	}
}

describe("the header", () => {
	it.each([EXPLICIT_LE, IMPLICIT_LE, EXPLICIT_BE])("reads the pixel module in %s", syntax => {
		const header = readHeader(memorySource(ctFile(syntax)), { decodeBytes: DECODE })
		const module = readPixelModule(header.dataSet, header.syntax?.littleEndian ?? true)

		expect(module).toMatchObject({
			rows: 2,
			columns: 3,
			bitsAllocated: 16,
			bitsStored: 12,
			highBit: 11,
			signed: true,
			intercept: -1024,
			modality: "CT",
			frames: 1,
			windows: [
				{ center: 40, width: 400, explanation: "SOFT" },
				{ center: 300, width: 1500, explanation: "BONE" }
			]
		})
		expect(imageVerdict(module, header.syntax, DECODERS)).toEqual({ status: "ok", color: "gray" })
	})

	it("reads a data set with no preamble or meta group", () => {
		const raw = dicomFile({
			transferSyntax: IMPLICIT_LE,
			raw: true,
			elements: [
				text(0x00080060, "CS", "MR"),
				...grayModule({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false })
			],
			pixelData: Uint8Array.from([1, 2])
		})
		const header = readHeader(memorySource(raw), { decodeBytes: DECODE })

		expect(header.transferSyntaxUid).toBe(IMPLICIT_LE)
		expect(readPixelModule(header.dataSet, true).modality).toBe("MR")
	})

	it("refuses what is not DICOM", () => {
		expect(() => readHeader(memorySource(new TextEncoder().encode("hello, world ".repeat(20))), { decodeBytes: DECODE })).toThrow(
			expect.objectContaining({ reason: "notDicom" })
		)
	})

	it("grows its prefix until Pixel Data's header, reading none of the pixels", () => {
		// 1.5 MiB of private data before the pixels: the first 1 MiB prefix ends inside it.
		const file = ctFile(EXPLICIT_LE, [binary(0x00091010, "OB", new Uint8Array(1.5 * MIB))])
		const big = new Uint8Array(file.length + 8 * MIB)

		big.set(file)

		const source = counting(big, big.length)
		const header = readHeader(source, { decodeBytes: DECODE })

		expect(header.dataSet.elements["x7fe00010"]).toBeDefined()
		expect(source.reach()).toBe(2 * MIB)
	})

	it("stops at the header cap, a share of the budget", () => {
		expect(headerCap(DECODE)).toBe(32 * MIB)
		expect(headerCap(384 * MIB)).toBe(12 * MIB)

		const file = ctFile(EXPLICIT_LE, [binary(0x00091010, "OB", new Uint8Array(3 * MIB))])

		expect(() => readHeader(memorySource(file), { decodeBytes: 2 * 32 * MIB })).toThrow(expect.objectContaining({ reason: "tooLarge" }))
	})

	it("inflates a deflated data set once, under what is left of the budget", () => {
		const file = ctFile(DEFLATED)
		const header = readHeader(memorySource(file), { decodeBytes: DECODE })

		expect(header.syntax?.deflated).toBe(true)
		expect(header.heldBytes).toBeGreaterThan(file.length / 2)
		expect(readPixelModule(header.dataSet, true).rows).toBe(2)
		// The inflated data set is past what is left once the file is held.
		expect(() => readHeader(memorySource(file), { decodeBytes: file.length + 16 })).toThrow(
			expect.objectContaining({ reason: "tooLarge" })
		)
	})

	it("refuses a deflated data set over 256 MiB on a ranged origin before reading it", () => {
		const head = ctFile(DEFLATED).subarray(0, 512)
		const read = vi.fn((offset: number, length: number) => {
			if (offset !== 0) throw new Error("read past the head")

			const out = new Uint8Array(length)

			out.set(head.subarray(0, Math.min(length, head.length)))

			return out
		})

		expect(() => readHeader({ size: DICOM_WHOLE_MAX_BYTES + 1, read }, { decodeBytes: DECODE })).toThrow(
			expect.objectContaining({ reason: "tooLarge" })
		)
		expect(read).toHaveBeenCalledTimes(1)
	})
})

describe("frames", () => {
	it("reads a native frame and its stored values in either byte order", () => {
		for (const syntax of [EXPLICIT_LE, EXPLICIT_BE]) {
			const { context: frame } = context(ctFile(syntax))
			const samples = nativeFrame(frame, 0)

			expect(samples.shift).toBe(0)
			expect([...samples.data].map(raw => ((raw & 0x800) !== 0 ? (raw & 0xfff) - 0x1000 : raw & 0xfff))).toEqual([
				-5, 0, 2047, -2048, 100, 7
			])
		}
	})

	it("refuses a frame over the pixel budget before reading it", () => {
		const { context: frame, source } = context(ctFile(EXPLICIT_LE))
		const header = source.reach()
		const tight: FrameContext = { ...frame, budget: { decodeBytes: 50, heldWith: () => 0 } }

		expect(() => nativeFrame(tight, 0)).toThrow(DicomFrameFailure)
		expect(source.reach()).toBe(header)
	})

	it("decodes RLE frames from their own fragments", async () => {
		const planes = (n: number) => [Uint8Array.from([n, n + 1]), Uint8Array.from([n + 2, n + 3])]
		const frames = [rleFrame(planes(1)), rleFrame(planes(5))]
		const file = dicomFile({
			transferSyntax: RLE,
			elements: grayModule({ rows: 1, columns: 2, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false, frames: 2 }),
			pixelData: encapsulated(frames, frameOffsets(frames))
		})
		const { context: frame } = context(file)
		const index = fragmentIndex(frame)

		if (index === null) throw new Error("no fragments")

		const second = await encapsulatedFrame(frame, index, 1)

		expect([...second.data]).toEqual([0x0507, 0x0608])
	})

	it("calls a frame's pixel data damaged when the value is shorter than its frames", () => {
		const file = dicomFile({
			transferSyntax: EXPLICIT_LE,
			elements: grayModule({ rows: 4, columns: 4, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false }),
			pixelData: new Uint8Array(8)
		})

		expect(() => nativeFrame(context(file).context, 0)).toThrow(expect.objectContaining({ reason: "damaged" }))
	})
})

describe("the image verdict", () => {
	function verdict(elements: ReturnType<typeof text>[], syntax = EXPLICIT_LE, pixelData: Uint8Array | null = new Uint8Array(4)) {
		const file = dicomFile({ transferSyntax: syntax, elements, ...(pixelData === null ? {} : { pixelData }) })
		const header = readHeader(memorySource(file), { decodeBytes: DECODE })

		return imageVerdict(readPixelModule(header.dataSet, true), header.syntax, DECODERS).status
	}

	const small = grayModule({ rows: 1, columns: 2, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: false })

	it("tells no image, an encoding without its decoder, damage and size apart", () => {
		expect(verdict(small, EXPLICIT_LE, null)).toBe("noImage")
		expect(verdict(small, JPEG_BASELINE, encapsulated([Uint8Array.from([0xff, 0xd8])]))).toBe("unsupported")
		expect(verdict(grayModule({ rows: 1, columns: 2, bitsAllocated: 16, bitsStored: 17, highBit: 16, signed: false }))).toBe("damaged")
		expect(verdict(grayModule({ rows: 16_385, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false }))).toBe(
			"tooLarge"
		)
		expect(verdict([...small.filter(element => element.tag !== 0x00280004), text(0x00280004, "CS", "YBR_PARTIAL_420")])).toBe(
			"unsupported"
		)
		expect(verdict(grayModule({ rows: 1, columns: 2, bitsAllocated: 1, bitsStored: 1, highBit: 0, signed: false }))).toBe("unsupported")
	})

	it("needs the palette for PALETTE COLOR", () => {
		const palette = [...small.filter(element => element.tag !== 0x00280004), text(0x00280004, "CS", "PALETTE COLOR")]
		const table = new Uint8Array(4)
		const tables = [0x00281201, 0x00281202, 0x00281203].map(tag => binary(tag, "OW", table))
		const descriptors = [0x00281101, 0x00281102, 0x00281103].map(tag => us(tag, 2, 0, 16))

		expect(verdict(palette)).toBe("unsupported")
		expect(verdict([...palette, ...tables, ...descriptors])).toBe("ok")
	})
})

describe("the tags", () => {
	it("names elements from the dictionary, decodes text by its character set and lists sequences' items", () => {
		const file = dicomFile({
			transferSyntax: EXPLICIT_LE,
			elements: [
				text(0x00080005, "CS", "ISO_IR 192"),
				text(0x00100010, "PN", "Ölçer^Zoë"),
				text(0x00091001, "LO", "vendor"),
				us(0x00280010, 512),
				sequence(0x00081115, [[text(0x0020000e, "UI", "1.2.3")], [text(0x0020000e, "UI", "1.2.4")]])
			]
		})
		const header = readHeader(memorySource(file), { decodeBytes: DECODE })
		const decoder = textDecoderFor(header.dataSet)
		const root = tagLevel(header.dataSet, [], decoder)
		const byTag = new Map(root.rows.map((row, index) => [row.tag, { row, index }]))

		expect(byTag.get("(0010,0010)")?.row).toMatchObject({ name: "Patient's Name", vr: "PN", value: "Ölçer^Zoë" })
		expect(byTag.get("(0028,0010)")?.row).toMatchObject({ name: "Rows", value: "512" })
		expect(byTag.get("(0009,1001)")?.row).toMatchObject({ name: null, isPrivate: true })

		const series = byTag.get("(0008,1115)")

		expect(series?.row).toMatchObject({ name: "Referenced Series Sequence", children: 2, value: null })

		const items = tagLevel(header.dataSet, [series?.index ?? -1], decoder)

		expect(items.rows.map(row => row.item)).toEqual([1, 2])
		expect(tagLevel(header.dataSet, [series?.index ?? -1, 1], decoder).rows[0]).toMatchObject({ tag: "(0020,000E)", value: "1.2.4" })
	})
})
