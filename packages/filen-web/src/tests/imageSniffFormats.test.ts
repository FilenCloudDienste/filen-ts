import { describe, expect, it } from "vitest"
import { MAX_EPSI_LINES, sniffEps } from "@/features/preview/lib/imageSniff/eps"
import { sniffJxl } from "@/features/preview/lib/imageSniff/jxl"
import { MAX_PSD_RESOURCE_BLOCKS, sniffPsd } from "@/features/preview/lib/imageSniff/psd"
import { sniffQoi } from "@/features/preview/lib/imageSniff/qoi"
import { MAX_TIFF_IFDS, sniffTiff } from "@/features/preview/lib/imageSniff/tiff"

// Bytes built field by field, big endian unless asked otherwise.
class Bytes {
	private readonly parts: number[] = []

	public u8(...values: number[]): this {
		this.parts.push(...values)

		return this
	}

	public u16(value: number, little = false): this {
		return little ? this.u8(value & 0xff, value >> 8) : this.u8(value >> 8, value & 0xff)
	}

	public u32(value: number, little = false): this {
		const bytes = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

		return this.u8(...(little ? bytes.toReversed() : bytes))
	}

	public ascii(text: string): this {
		return this.u8(...new TextEncoder().encode(text))
	}

	public zeros(count: number): this {
		return this.u8(...new Array<number>(count).fill(0))
	}

	public get length(): number {
		return this.parts.length
	}

	public build(): Uint8Array {
		return Uint8Array.from(this.parts)
	}
}

// Writes `bits` of `value` least significant bit first, as JPEG XL packs its headers.
function jxlBits(fields: readonly (readonly [value: number, bits: number])[]): number[] {
	const out: number[] = []
	let position = 0

	for (const [value, bits] of fields) {
		for (let i = 0; i < bits; i++) {
			const byte = position >> 3

			out[byte] = (out[byte] ?? 0) | ((Math.floor(value / 2 ** i) % 2) << (position & 7))
			position++
		}
	}

	return out
}

// 1000 × 750: not small, height selector 1 (13 bits) → 749, ratio 3 (4:3).
const JXL_CODESTREAM = [
	0xff,
	0x0a,
	...jxlBits([
		[0, 1],
		[1, 2],
		[749, 13],
		[3, 3]
	])
]
const JXL_SIGNATURE = new Bytes().u32(12).ascii("JXL ").u8(0x0d, 0x0a, 0x87, 0x0a)
const FTYP = new Bytes().u32(20).ascii("ftyp").ascii("jxl ").u32(0).ascii("jxl ")

function jxlContainer(...boxes: Bytes[]): Uint8Array {
	return Uint8Array.from([...JXL_SIGNATURE.build(), ...boxes.flatMap(box => [...box.build()])])
}

describe("sniffJxl", () => {
	it("reads a bare codestream's size, with a fixed aspect ratio", () => {
		const head = Uint8Array.from(JXL_CODESTREAM)

		expect(sniffJxl(head, head.length)).toEqual({ width: 1000, height: 750 })
	})

	it("reads a small image's size in multiples of 8, both sides stored", () => {
		const head = Uint8Array.from([
			0xff,
			0x0a,
			...jxlBits([
				[1, 1],
				[3, 5],
				[0, 3],
				[7, 5]
			])
		])

		expect(sniffJxl(head, head.length)).toEqual({ width: 64, height: 32 })
	})

	it("reads a 30-bit dimension", () => {
		const head = Uint8Array.from([
			0xff,
			0x0a,
			...jxlBits([
				[0, 1],
				[3, 2],
				[99_999, 30],
				[0, 3],
				[2, 2],
				[199_999, 18]
			])
		])

		expect(sniffJxl(head, head.length)).toEqual({ width: 200_000, height: 100_000 })
	})

	it("finds the codestream in a jxlc box and in the first jxlp box", () => {
		const jxlc = new Bytes()
			.u32(8 + JXL_CODESTREAM.length)
			.ascii("jxlc")
			.u8(...JXL_CODESTREAM)
		const jxlp = new Bytes()
			.u32(12 + JXL_CODESTREAM.length)
			.ascii("jxlp")
			.u32(0)
			.u8(...JXL_CODESTREAM)

		for (const head of [jxlContainer(FTYP, jxlc), jxlContainer(FTYP, jxlp)]) {
			expect(sniffJxl(head, head.length)).toEqual({ width: 1000, height: 750 })
		}
	})

	it("takes a 64-bit largesize box and a size-0 box that runs to the end", () => {
		const large = new Bytes()
			.u32(1)
			.ascii("jxlc")
			.u32(0)
			.u32(16 + JXL_CODESTREAM.length)
			.u8(...JXL_CODESTREAM)
		const toEnd = new Bytes()
			.u32(0)
			.ascii("jxlc")
			.u8(...JXL_CODESTREAM)

		for (const head of [jxlContainer(FTYP, large), jxlContainer(FTYP, toEnd)]) {
			expect(sniffJxl(head, head.length)).toEqual({ width: 1000, height: 750 })
		}
	})

	it("refuses a box shorter than its own header, and a size-0 box that is not the codestream", () => {
		const short = jxlContainer(new Bytes().u32(4).ascii("free"))
		const shortLarge = jxlContainer(new Bytes().u32(1).ascii("free").u32(0).u32(12))
		const lastFree = jxlContainer(new Bytes().u32(0).ascii("free").zeros(8))

		for (const head of [short, shortLarge, lastFree]) {
			expect(sniffJxl(head, head.length)).toBeNull()
		}
	})

	it("refuses a box reaching past the file", () => {
		const head = jxlContainer(
			FTYP,
			new Bytes()
				.u32(4096)
				.ascii("jxlc")
				.u8(...JXL_CODESTREAM)
		)

		expect(sniffJxl(head, head.length)).toBeNull()
	})

	it("stops after a bounded number of boxes", () => {
		const free = new Bytes().u32(8).ascii("free")
		const head = jxlContainer(
			...Array.from({ length: 300 }, () => free),
			new Bytes()
				.u32(0)
				.ascii("jxlc")
				.u8(...JXL_CODESTREAM)
		)

		expect(sniffJxl(head, head.length)).toBeNull()
	})

	it("gives up on a codestream cut off by the head", () => {
		const head = Uint8Array.from(JXL_CODESTREAM.slice(0, 3))

		expect(sniffJxl(head, 1 << 20)).toBeNull()
	})

	it("ignores other formats", () => {
		const head = new Bytes().u8(0xff, 0xd8, 0xff).zeros(16).build()

		expect(sniffJxl(head, head.length)).toBeNull()
	})
})

// One IFD at `at`: the width and height entries (SHORT or LONG), then the next IFD's offset.
function ifd(bytes: Bytes, next: number, little: boolean, size?: { width: number; height: number; long?: boolean }): Bytes {
	const entries = size === undefined ? [] : [[256, size.width] as const, [257, size.height] as const]

	bytes.u16(entries.length, little)

	for (const [tag, value] of entries) {
		bytes
			.u16(tag, little)
			.u16(size?.long === true ? 4 : 3, little)
			.u32(1, little)

		if (size?.long === true) {
			bytes.u32(value, little)
		} else {
			bytes.u16(value, little).u16(0)
		}
	}

	return bytes.u32(next, little)
}

function tiffHeader(little: boolean, first = 8): Bytes {
	return (little ? new Bytes().ascii("II").u16(42, true) : new Bytes().ascii("MM").u16(42)).u32(first, little)
}

describe("sniffTiff", () => {
	it("reads page 1's size and the page count in both byte orders", () => {
		for (const little of [true, false]) {
			// IFD0 at 8 (30 bytes), IFD1 at 38.
			const bytes = ifd(tiffHeader(little), 38, little, { width: 640, height: 480 })
			const head = ifd(bytes, 0, little).build()

			expect(sniffTiff(head, head.length)).toEqual({ kind: "tiff", size: { width: 640, height: 480 }, pages: 2 })
		}
	})

	it("reads LONG dimensions", () => {
		const head = ifd(tiffHeader(true), 0, true, { width: 100_000, height: 70_000, long: true }).build()

		expect(sniffTiff(head, head.length)).toEqual({ kind: "tiff", size: { width: 100_000, height: 70_000 }, pages: 1 })
	})

	it("tells BigTIFF from its header alone", () => {
		const head = new Bytes().ascii("II").u16(43, true).u16(8, true).u16(0).zeros(8).build()

		expect(sniffTiff(head, 1 << 30)).toEqual({ kind: "bigTiff" })
	})

	it("leaves the size and page count unknown when IFD0 lies past the head", () => {
		const head = tiffHeader(true, 1 << 20)
			.zeros(56)
			.build()

		expect(sniffTiff(head, 2 << 20)).toEqual({ kind: "tiff", size: null, pages: null })
	})

	it("refuses an IFD0 offset outside the file or inside the header", () => {
		expect(sniffTiff(tiffHeader(true, 4096).zeros(8).build(), 4096)).toBeNull()
		expect(sniffTiff(tiffHeader(true, 4).zeros(8).build(), 4096)).toBeNull()
	})

	it("stops at an IFD that points at itself or back", () => {
		const self = ifd(tiffHeader(true), 8, true, { width: 10, height: 10 }).build()
		const back = ifd(ifd(tiffHeader(true), 38, true, { width: 10, height: 10 }), 8, true).build()

		expect(sniffTiff(self, self.length)).toEqual({ kind: "tiff", size: { width: 10, height: 10 }, pages: null })
		expect(sniffTiff(back, back.length)).toEqual({ kind: "tiff", size: { width: 10, height: 10 }, pages: null })
	})

	it("stops counting after a bounded number of IFDs", () => {
		const bytes = tiffHeader(true)

		for (let i = 0; i < 100; i++) {
			// Empty IFDs of 6 bytes, back to back.
			ifd(bytes, i === 99 ? 0 : bytes.length + 6, true)
		}

		const head = bytes.build()

		expect(MAX_TIFF_IFDS).toBe(64)
		expect(sniffTiff(head, head.length)).toEqual({ kind: "tiff", size: null, pages: null })
	})

	it("gives up on an IFD cut off by the head", () => {
		const head = ifd(tiffHeader(true), 0, true, { width: 10, height: 10 }).build().subarray(0, 20)

		expect(sniffTiff(head, 4096)).toEqual({ kind: "tiff", size: null, pages: null })
	})

	it("ignores other formats", () => {
		const head = new Bytes().ascii("II").u16(41, true).u32(8, true).build()

		expect(sniffTiff(head, head.length)).toBeNull()
	})
})

describe("sniffQoi", () => {
	it("reads the size and whether there is alpha", () => {
		expect(sniffQoi(new Bytes().ascii("qoif").u32(800).u32(600).u8(4, 0).build())).toEqual({ width: 800, height: 600, hasAlpha: true })
		expect(sniffQoi(new Bytes().ascii("qoif").u32(1).u32(2).u8(3, 1).build())).toEqual({ width: 1, height: 2, hasAlpha: false })
	})

	it("refuses a cut-off header, a zero side and unknown channel counts or colour spaces", () => {
		expect(sniffQoi(new Bytes().ascii("qoif").u32(800).u32(600).build())).toBeNull()
		expect(sniffQoi(new Bytes().ascii("qoif").u32(0).u32(600).u8(4, 0).build())).toBeNull()
		expect(sniffQoi(new Bytes().ascii("qoif").u32(8).u32(6).u8(2, 0).build())).toBeNull()
		expect(sniffQoi(new Bytes().ascii("qoif").u32(8).u32(6).u8(4, 2).build())).toBeNull()
	})

	it("reads the largest sides the header can hold", () => {
		expect(sniffQoi(new Bytes().ascii("qoif").u32(0xffffffff).u32(0xffffffff).u8(4, 0).build())).toEqual({
			width: 0xffffffff,
			height: 0xffffffff,
			hasAlpha: true
		})
	})
})

function psdHeader(version: number, options?: { colourModeBytes?: number }): Bytes {
	const colourModeBytes = options?.colourModeBytes ?? 0

	return new Bytes()
		.ascii("8BPS")
		.u16(version)
		.zeros(6)
		.u16(3)
		.u32(4000)
		.u32(6000)
		.u16(8)
		.u16(3)
		.u32(colourModeBytes)
		.zeros(colourModeBytes)
}

function resource(id: number, dataBytes: number, name = ""): Bytes {
	const block = new Bytes().ascii("8BIM").u16(id).u8(name.length).ascii(name)

	if ((name.length + 1) % 2 === 1) {
		block.u8(0)
	}

	return block
		.u32(dataBytes)
		.zeros(dataBytes)
		.zeros(dataBytes % 2)
}

function withResources(header: Bytes, blocks: readonly Bytes[], declared?: number): Uint8Array {
	const body = blocks.flatMap(block => [...block.build()])

	return Uint8Array.from([...header.u32(declared ?? body.length).build(), ...body])
}

describe("sniffPsd", () => {
	it("reads the header of a PSD and a PSB", () => {
		for (const version of [1, 2]) {
			const head = withResources(psdHeader(version), [])

			expect(sniffPsd(head, head.length)).toMatchObject({
				version,
				channels: 3,
				width: 6000,
				height: 4000,
				depth: 8,
				mode: 3,
				thumbnail: null,
				resources: "searched"
			})
		}
	})

	it("finds the thumbnail resource, past named and odd-sized blocks, preferring 1036 to 1033", () => {
		const head = withResources(psdHeader(1, { colourModeBytes: 768 }), [
			resource(1005, 15, "odd"),
			resource(1033, 40),
			resource(1036, 128),
			resource(1039, 4)
		])
		const result = sniffPsd(head, head.length)

		expect(result?.thumbnail?.id).toBe(1036)
		expect(result?.resources).toBe("searched")

		const offset = result?.thumbnail?.jpeg.offset ?? 0

		// The JFIF data starts after the resource's 28-byte header and fills the rest of it.
		expect(result?.thumbnail?.jpeg.length).toBe(100)
		expect(Array.from(head.subarray(offset - 32, offset - 28))).toEqual([0, 0, 0, 128])
	})

	it("falls back to the Photoshop 4 thumbnail", () => {
		const head = withResources(psdHeader(1), [resource(1033, 60)])

		expect(sniffPsd(head, head.length)?.thumbnail).toMatchObject({ id: 1033, jpeg: { length: 32 } })
	})

	it("locates a thumbnail whose data lies beyond the head from its block header", () => {
		const file = withResources(psdHeader(1), [resource(1005, 16), resource(1036, 4096)])
		const head = file.subarray(0, 80)
		const result = sniffPsd(head, file.length)

		expect(result?.thumbnail?.id).toBe(1036)
		expect(result?.resources).toBe("searched")
		expect(Array.from(file.subarray((result?.thumbnail?.jpeg.offset ?? 0) - 32, (result?.thumbnail?.jpeg.offset ?? 0) - 28))).toEqual([
			0, 0, 0x10, 0
		])
	})

	it("asks for more when the head ends inside the resources section", () => {
		const file = withResources(psdHeader(1), [resource(1005, 200), resource(1036, 64)])
		const result = sniffPsd(file.subarray(0, 100), file.length)

		expect(result).toMatchObject({ thumbnail: null, resources: "needsMore", resourcesEnd: file.length })
	})

	it("asks for more when the colour mode data leaves the head", () => {
		const file = withResources(psdHeader(1, { colourModeBytes: 768 }), [])

		expect(sniffPsd(file.subarray(0, 64), file.length)).toMatchObject({ resources: "needsMore", resourcesEnd: null })
	})

	it("stops after a bounded number of resource blocks", () => {
		const blocks = Array.from({ length: 2000 }, () => resource(1000, 0))
		const head = withResources(psdHeader(1), [...blocks, resource(1036, 64)])
		const result = sniffPsd(head, head.length)

		expect(MAX_PSD_RESOURCE_BLOCKS).toBe(1024)
		expect(result).toMatchObject({ thumbnail: null, resources: "searched" })
	})

	it("stops at a block that is not a resource or overruns its section, and clamps the section to the file", () => {
		const garbage = withResources(psdHeader(1), [new Bytes().ascii("XXXX").zeros(12), resource(1036, 64)])
		const overrun = withResources(psdHeader(1), [resource(1036, 64)], 40)
		const clamped = withResources(psdHeader(1), [resource(1036, 64)], 0x7fffffff)

		expect(sniffPsd(garbage, garbage.length)).toMatchObject({ thumbnail: null, resources: "searched" })
		expect(sniffPsd(overrun, overrun.length)).toMatchObject({ thumbnail: null, resources: "searched" })
		expect(sniffPsd(clamped, clamped.length)).toMatchObject({ resourcesEnd: clamped.length, thumbnail: { id: 1036 } })
	})

	it("refuses other versions and empty images", () => {
		const v3 = withResources(psdHeader(3), [])
		const empty = Uint8Array.from(withResources(psdHeader(1), []))

		empty.fill(0, 14, 18)

		expect(sniffPsd(v3, v3.length)).toBeNull()
		expect(sniffPsd(empty, empty.length)).toBeNull()
	})
})

function dosEps(sections: readonly (readonly [offset: number, length: number])[]): Bytes {
	const bytes = new Bytes().u8(0xc5, 0xd0, 0xd3, 0xc6)

	for (const [offset, length] of sections) {
		bytes.u32(offset, true).u32(length, true)
	}

	return bytes.u16(0xffff)
}

describe("sniffEps", () => {
	it("reads a DOS EPS header's sections", () => {
		const head = dosEps([
			[30, 1000],
			[0, 0],
			[1030, 5000]
		]).build()

		expect(sniffEps(head, 6030)).toEqual({
			kind: "dos",
			postScript: { offset: 30, length: 1000 },
			wmf: null,
			tiff: { offset: 1030, length: 5000 }
		})
	})

	it("drops sections outside the file or overlapping the header", () => {
		const head = dosEps([
			[30, 1000],
			[10, 20],
			[0xfffffff0, 0x100]
		]).build()

		expect(sniffEps(head, 6030)).toEqual({ kind: "dos", postScript: { offset: 30, length: 1000 }, wmf: null, tiff: null })
		expect(sniffEps(head.subarray(0, 20), 6030)).toBeNull()
	})

	it("reads an EPSI preview's declaration", () => {
		const head = new Bytes().ascii("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 80 24\n%%BeginPreview: 80 24 1 24\r\n% FF00\n").build()
		const result = sniffEps(head, head.length)

		expect(result).toEqual({
			kind: "epsi",
			preview: { width: 80, height: 24, depth: 1, lines: 24, dataStart: head.indexOf(0x25, 60) }
		})
	})

	it("treats a malformed or oversized preview declaration as no preview", () => {
		for (const line of ["80 24 3 24", "80 24 1", "80 x 1 24", "0 24 1 24", `80 24 8 ${String(MAX_EPSI_LINES + 1)}`, "80 24 1 24"]) {
			const text = `%!PS-Adobe-3.0 EPSF-3.0\n%%BeginPreview: ${line}`
			// The last case is cut off by the head before its line ends.
			const head = new Bytes().ascii(line === "80 24 1 24" ? text : `${text}\n`).build()

			expect(sniffEps(head, head.length)).toEqual({ kind: "plain" })
		}
	})

	it("ignores other formats", () => {
		const head = new Bytes().ascii("%PDF-1.7\n").build()

		expect(sniffEps(head, head.length)).toBeNull()
	})
})
