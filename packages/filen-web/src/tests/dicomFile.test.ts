import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	DICOM_HEADER_HEAP_PER_BYTE,
	DicomOpenError,
	fileHeld,
	headerCap,
	memorySource,
	rangeSource,
	readHeader,
	type DicomSource
} from "@/features/preview/lib/dicom/dicomFile"
import { imageVerdict, readPixelModule } from "@/features/preview/lib/dicom/pixelModule"
import {
	DICOM_J2K_HEAD_BYTES,
	DicomFrameFailure,
	encapsulatedFrame,
	fragmentIndex,
	nativeFrame,
	type FrameContext
} from "@/features/preview/lib/dicom/frameDecode"
import { DICOM_MIN_CODE_BLOCK, structureBytes } from "@/features/preview/lib/dicom/budget.logic"
import { jpeg2000Header } from "@/features/preview/lib/dicom/codestream.logic"
import { TAG_VALUE_CHARS, tagLevel, tagValue, textOf } from "@/features/preview/lib/dicom/tagTree"
import { DICOM_WHOLE_MAX_BYTES, type DicomDecoder } from "@/features/preview/lib/dicom/transferSyntax"
import {
	DEFLATED,
	EXPLICIT_BE,
	EXPLICIT_LE,
	IMPLICIT_LE,
	HTJ2K,
	JPEG_2000,
	JPEG_BASELINE,
	RLE,
	binary,
	dicomFile,
	encapsulated,
	frameOffsets,
	grayModule,
	rleFrame,
	sequence,
	siz,
	text,
	us
} from "@/tests/support/dicomBytes"

// A DICOM file's header read from a growing prefix, its Image Pixel module, its frames under the pixel budget and its
// tags, on files written from scratch.

const MIB = 1024 * 1024
const DECODE = 1024 * MIB
const DECODERS: ReadonlySet<DicomDecoder> = new Set(["native", "rle", "jpeg2000", "htj2k"])

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

// Counts how far into the file reads reach, and how many bytes they read.
function counting(bytes: Uint8Array, size = bytes.length): DicomSource & { reach: () => number; total: () => number } {
	let furthest = 0
	let read = 0

	return {
		size,
		inMemory: false,
		read: (offset, length) => {
			furthest = Math.max(furthest, offset + length)
			read += length

			if (offset + length > bytes.length) throw new DicomOpenError("unreadable", "past the test bytes")

			return bytes.slice(offset, offset + length)
		},
		reach: () => furthest,
		total: () => read
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
			budget: { decodeBytes, held: () => fileHeld(header, 0), heap: () => 0, settle: () => undefined },
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

	it("charges the parsed header's heap, and a prefix copied to parse it, against the frames' budget", () => {
		const file = ctFile(EXPLICIT_LE)
		const inMemory = readHeader(memorySource(file), { decodeBytes: DECODE })
		const pixelOffset = inMemory.dataSet.elements["x7fe00010"]?.dataOffset ?? 0
		const ranged = readHeader(counting(file), { decodeBytes: DECODE })

		expect(inMemory.headerBytes).toBe(pixelOffset * DICOM_HEADER_HEAP_PER_BYTE)
		expect(ranged.headerBytes).toBe(pixelOffset * DICOM_HEADER_HEAP_PER_BYTE + file.length)
		expect(fileHeld(inMemory, file.length)).toBe(file.length + inMemory.headerBytes)

		// The 3×2 frame: its 12 bytes, 12 more swapped out of them and 48 drawn.
		const { context: frame } = context(file)
		const fits = ranged.headerBytes + 72

		expect(nativeFrame({ ...frame, budget: { ...frame.budget, decodeBytes: fits } }, 0).rows).toBe(2)
		expect(() => nativeFrame({ ...frame, budget: { ...frame.budget, decodeBytes: fits - 1 } }, 0)).toThrow(
			expect.objectContaining({ reason: "tooLarge" })
		)
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

	it("calls a header damaged at once when no longer prefix could mend it, rather than reading up to the cap", () => {
		// A ranged file of 64 MiB whose first prefix holds the meta group, then `body`.
		const ranged = (body: number[]) => {
			const head = dicomFile({ transferSyntax: EXPLICIT_LE, elements: [text(0x00080060, "CS", "CT")] })
			const big = new Uint8Array(64 * MIB)

			big.set(head)
			big.set(body, head.length)

			return counting(big)
		}
		const le16 = (value: number) => [value & 0xff, value >> 8]
		const le32 = (value: number) => [...le16(value & 0xffff), ...le16(value >>> 16)]

		// An OB value of 4 GiB, past the end of the file.
		const huge = ranged([...le16(0x0009), ...le16(0x1010), 0x4f, 0x42, 0, 0, ...le32(0xfffffff0)])

		expect(() => readHeader(huge, { decodeBytes: DECODE })).toThrow(expect.objectContaining({ reason: "damaged" }))
		expect(huge.reach()).toBe(MIB)

		// Sequences nested deeper than the parser's stack.
		const nested: number[] = []

		for (let depth = 0; depth < 40_000; depth++) {
			nested.push(...le16(0x0040), ...le16(0xa730), 0x53, 0x51, 0, 0, ...le32(0xffffffff))
			nested.push(...le16(0xfffe), ...le16(0xe000), ...le32(0xffffffff))
		}

		const deep = ranged(nested)

		expect(() => readHeader(deep, { decodeBytes: DECODE })).toThrow(expect.objectContaining({ reason: "damaged" }))
		expect(deep.reach()).toBe(MIB)
	})

	it("refuses a deflated data set over 256 MiB on a ranged origin before reading it", () => {
		const head = ctFile(DEFLATED).subarray(0, 512)
		const read = vi.fn((offset: number, length: number) => {
			if (offset !== 0) throw new Error("read past the head")

			const out = new Uint8Array(length)

			out.set(head.subarray(0, Math.min(length, head.length)))

			return out
		})

		expect(() => readHeader({ size: DICOM_WHOLE_MAX_BYTES + 1, inMemory: false, read }, { decodeBytes: DECODE })).toThrow(
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
		const tight: FrameContext = { ...frame, budget: { ...frame.budget, decodeBytes: 50 } }

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

	it("bounds an offset table's fragments by the file, before reading them", async () => {
		const last = rleFrame([Uint8Array.from([3, 4])])
		const frames = [rleFrame([Uint8Array.from([1, 2])]), last]
		const file = dicomFile({
			transferSyntax: RLE,
			elements: grayModule({ rows: 1, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false, frames: 2 }),
			pixelData: encapsulated(frames, frameOffsets(frames))
		})
		// The second fragment's item claims 4 GiB.
		const second = file.length - 8 - (8 + last.length) + 4

		new DataView(file.buffer).setUint32(second, 0xfffffff0, true)

		const { context: frame, source } = context(file)
		const index = fragmentIndex(frame)

		if (index === null) throw new Error("no fragments")

		await expect(encapsulatedFrame(frame, index, 1)).rejects.toMatchObject({ reason: "damaged" })
		expect(source.reach()).toBeLessThanOrEqual(file.length)
	})

	it("refuses a JPEG 2000 frame no resolution of which fits, from its first bytes, before reading it", async () => {
		const side = 16_384
		const codestream = new Uint8Array(4 * DICOM_J2K_HEAD_BYTES)

		codestream.set(siz(side, side, 1, 16, 2))

		const file = dicomFile({
			transferSyntax: JPEG_2000,
			elements: grayModule({ rows: side, columns: side, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false }),
			pixelData: encapsulated([codestream])
		})
		const { context: frame, source } = context(file)
		const decode = vi.fn()
		const index = fragmentIndex(frame)

		if (index === null) throw new Error("no fragments")

		const header = source.total()
		// Two reductions leave 4096² pixels, at 20 bytes each and the encoded frame twice: short of that refuses the frame.
		const tight: FrameContext = { ...frame, compressed: decode, budget: { ...frame.budget, decodeBytes: 4096 * 4096 * 20 } }

		await expect(encapsulatedFrame(tight, index, 0)).rejects.toMatchObject({ reason: "tooLarge" })
		// The item headers and the head of the fragment, not the fragment.
		expect(source.total() - header).toBeLessThan(DICOM_J2K_HEAD_BYTES + 64)

		// Nothing left at all once the frame's bytes are held: refused before even its head is read.
		const before = source.total()
		const spent: FrameContext = { ...frame, compressed: decode, budget: { ...frame.budget, decodeBytes: 1000, held: () => 1000 } }

		await expect(encapsulatedFrame(spent, index, 0)).rejects.toMatchObject({ reason: "tooLarge" })
		expect(source.total()).toBe(before)
		expect(decode).not.toHaveBeenCalled()
	})

	it("tells the worker a codec's need once its frame has decoded, so a grown heap can be let go", async () => {
		const codestream = siz(4, 2, 1, 16, 0)
		const file = dicomFile({
			transferSyntax: JPEG_2000,
			elements: grayModule({ rows: 2, columns: 4, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false }),
			pixelData: encapsulated([codestream])
		})
		const { context: frame } = context(file)
		const settle = vi.fn()
		const decoded = {
			data: new Uint16Array(8),
			rows: 2,
			columns: 4,
			samplesPerPixel: 1,
			color: "gray" as const,
			planar: false,
			shift: 0
		}
		const index = fragmentIndex(frame)

		if (index === null) throw new Error("no fragments")

		await encapsulatedFrame({ ...frame, compressed: () => Promise.resolve(decoded), budget: { ...frame.budget, settle } }, index, 0)
		// OpenJPEG: 10 bytes a 16-bit pixel, the encoded frame, and its one tile and code block, in its heap.
		const structure = structureBytes("jpeg2000", { rows: 2, columns: 4, components: 1, tiles: 1, codeBlock: 64 })

		expect(settle).toHaveBeenCalledWith("jpeg2000", 8 * 10 + codestream.length + (codestream.length % 2) + structure)
	})

	// Hostile codestreams of a few hundred bytes that pass every header check and grow a decoder's heap far past a
	// phone's budget, written by the codecs' own encoders (cornerstone codec-openjph 2.4.11 and codec-openjpeg 1.3.6,
	// flat 8-bit content): ht-cb4.j2c, 16 × 16 in 4 × 4 code blocks (OpenJPH's heap: 430 MiB); oj-siz-tiles-1.j2k and
	// -3.j2k, 255 × 256 with SIZ patched to one-pixel tiles, 65,280 of them (OpenJPEG's: 604 and 796 MiB);
	// ht-tile1-head.j2c, the first 4 KiB of a 255 × 256 HTJ2K stream encoded in one-pixel tiles (OpenJPH's: 1.30 GiB).
	const hostile = (name: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", "dicom", name)))
	const MOBILE = 384 * MIB

	it.each([
		["oj-siz-tiles-1.j2k", JPEG_2000, 1, 604 * MIB],
		["oj-siz-tiles-3.j2k", JPEG_2000, 3, 796 * MIB],
		["ht-tile1-head.j2c", HTJ2K, 1, 1.3 * 1024 * MIB]
	] as const)(
		"counts %s's tiles in its codec's heap, refusing it on a phone before it is decoded",
		async (name, syntax, components, measured) => {
			const codestream = hostile(name)
			const header = jpeg2000Header(codestream)

			expect(header).toMatchObject({ rows: 256, columns: 255, components, tiles: 65_280 })

			if (header === null) throw new Error("no header")

			// What it is charged covers what it was measured to take.
			expect(structureBytes(syntax === HTJ2K ? "htj2k" : "jpeg2000", header)).toBeGreaterThanOrEqual(measured)

			const pixelModule =
				components === 1
					? grayModule({ rows: 256, columns: 255, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false })
					: [
							us(0x00280002, 3),
							text(0x00280004, "CS", "RGB"),
							us(0x00280006, 0),
							us(0x00280010, 256),
							us(0x00280011, 255),
							us(0x00280100, 8),
							us(0x00280101, 8),
							us(0x00280102, 7),
							us(0x00280103, 0)
						]
			const file = dicomFile({ transferSyntax: syntax, elements: pixelModule, pixelData: encapsulated([codestream]) })
			const { context: frame } = context(file, MOBILE)
			const decode = vi.fn()
			const index = fragmentIndex(frame)

			if (index === null) throw new Error("no fragments")

			await expect(encapsulatedFrame({ ...frame, compressed: decode }, index, 0)).rejects.toMatchObject({ reason: "tooLarge" })
			expect(decode).not.toHaveBeenCalled()
		}
	)

	it("refuses code blocks under 16 pixels a side before they reach a decoder", async () => {
		const codestream = hostile("ht-cb4.j2c")
		const header = jpeg2000Header(codestream)

		expect(header).toMatchObject({ rows: 16, columns: 16, codeBlock: 4 })
		expect(DICOM_MIN_CODE_BLOCK).toBe(16)
		// Were it decoded, its code blocks would be charged what OpenJPH was measured to take.
		if (header !== null) expect(structureBytes("htj2k", header)).toBeGreaterThanOrEqual(430 * MIB)

		const file = dicomFile({
			transferSyntax: HTJ2K,
			elements: grayModule({ rows: 16, columns: 16, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false }),
			pixelData: encapsulated([codestream])
		})
		const { context: frame } = context(file, MOBILE)
		const decode = vi.fn()
		const index = fragmentIndex(frame)

		if (index === null) throw new Error("no fragments")

		await expect(encapsulatedFrame({ ...frame, compressed: decode }, index, 0)).rejects.toMatchObject({ reason: "unsupported" })
		expect(decode).not.toHaveBeenCalled()

		// A component's own COC setting 8-pixel-wide blocks under COD's 64 × 64: its xcb, 6 bytes from the end.
		const main = siz(64, 48, 1, 8, 2, { componentLevels: [{ component: 0, levels: 2 }] })

		main[main.length - 6] = 1
		expect(jpeg2000Header(main)?.codeBlock).toBe(8)
	})

	it("reads a range only within the file, allocating nothing for a read past its end", () => {
		const readInto = vi.fn((out: Uint8Array) => out.length)
		const source = rangeSource(100, readInto)

		expect(source.read(90, 10)).toHaveLength(10)
		expect(() => source.read(90, 0xfffffff0)).toThrow(expect.objectContaining({ reason: "damaged" }))
		expect(() => source.read(-1, 1)).toThrow(DicomOpenError)
		expect(readInto).toHaveBeenCalledTimes(1)
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
		expect(
			verdict(grayModule({ rows: 1, columns: 2, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: false, frames: 2_000_000 }))
		).toBe("tooLarge")
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
		const decoder = textOf(header.dataSet, null)
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

	it("reads an implicit VR value whose dictionary entry allows US or SS by Pixel Representation", () => {
		const int16 = (value: number) => new Uint8Array(Int16Array.of(value).buffer)
		const rows = (signed: boolean) => {
			const file = dicomFile({
				transferSyntax: IMPLICIT_LE,
				elements: [
					us(0x00280103, signed ? 1 : 0),
					binary(0x00280106, "SS", int16(-5)),
					us(0x00281101, 256, 0, 16),
					binary(0x00281201, "OW", new Uint8Array(4))
				]
			})
			const header = readHeader(memorySource(file), { decodeBytes: DECODE })

			return new Map(tagLevel(header.dataSet, [], textOf(header.dataSet, null)).rows.map(row => [row.tag, row]))
		}

		expect(rows(true).get("(0028,0106)")).toMatchObject({ vr: "SS", value: "-5" })
		expect(rows(false).get("(0028,0106)")).toMatchObject({ vr: "US", value: "65531" })
		expect(rows(false).get("(0028,1101)")).toMatchObject({ vr: "US", value: "256\\0\\16" })
		expect(rows(false).get("(0028,1201)")).toMatchObject({ vr: "OW", value: null })
	})

	it("cuts a long value for its row, and gives the whole of it for a copy", () => {
		const long = "x".repeat(TAG_VALUE_CHARS * 2)
		const many = Array.from({ length: 100 }, (_, i) => i)
		const file = dicomFile({
			transferSyntax: EXPLICIT_LE,
			elements: [text(0x00081030, "LO", long), us(0x00283002, ...many)]
		})
		const header = readHeader(memorySource(file), { decodeBytes: DECODE })
		const rootText = textOf(header.dataSet, null)
		const rows = tagLevel(header.dataSet, [], rootText).rows
		const at = (tag: string) => rows.findIndex(row => row.tag === tag)
		const description = rows[at("(0008,1030)")]
		const lut = rows[at("(0028,3002)")]

		expect(description).toMatchObject({ truncated: true, value: `${"x".repeat(TAG_VALUE_CHARS)}…` })
		expect(tagValue(header.dataSet, [at("(0008,1030)")], rootText)).toBe(long)
		expect(lut?.truncated).toBe(true)
		expect(lut?.value?.endsWith("\\63\\…")).toBe(true)
		expect(tagValue(header.dataSet, [at("(0028,3002)")], rootText)).toBe(many.join("\\"))
		expect(rows.find(row => row.tag === "(0002,0010)")?.truncated).toBe(false)
	})

	it("reads an item's text by its own character set, else its parent's", () => {
		const latin = Uint8Array.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72])
		const file = dicomFile({
			transferSyntax: EXPLICIT_LE,
			elements: [
				text(0x00080005, "CS", "ISO_IR 100"),
				binary(0x00100010, "PN", latin),
				sequence(0x00081115, [
					[binary(0x00100010, "PN", latin)],
					[text(0x00080005, "CS", "ISO_IR 192"), text(0x00100010, "PN", "Zoë")]
				])
			]
		})
		const header = readHeader(memorySource(file), { decodeBytes: DECODE })
		const rootText = textOf(header.dataSet, null)
		const root = tagLevel(header.dataSet, [], rootText)
		const series = root.rows.findIndex(row => row.tag === "(0008,1115)")
		const name = (item: number) => tagLevel(header.dataSet, [series, item], rootText).rows.find(row => row.tag === "(0010,0010)")?.value

		expect(root.rows.find(row => row.tag === "(0010,0010)")?.value).toBe("Müller")
		expect(name(0)).toBe("Müller")
		expect(name(1)).toBe("Zoë")
	})
})
