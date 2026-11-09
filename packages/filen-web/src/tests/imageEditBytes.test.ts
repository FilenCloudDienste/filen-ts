import { crc32 as zlibCrc32 } from "node:zlib"
import { describe, expect, it } from "vitest"
import { heifExif, heifIcc, sniffHeif } from "@/features/preview/imageEdit/lib/heifMeta"
import {
	buildJpeg,
	normalizeExif,
	readExifOrientation,
	rewriteOrientationHead,
	walkJpegSegments
} from "@/features/preview/imageEdit/lib/jpegMeta"
import { buildPng, pngChunk, walkPngChunks } from "@/features/preview/imageEdit/lib/pngMeta"
import { sniffImage } from "@/features/preview/imageEdit/lib/sniff"
import { buildWebp, walkWebpChunks } from "@/features/preview/imageEdit/lib/webpMeta"

// ── Byte helpers ─────────────────────────────────────────────────────────────

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
	const arrays = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
	const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
	let at = 0

	for (const a of arrays) {
		out.set(a, at)
		at += a.length
	}

	return out
}

const ascii = (text: string): Uint8Array => Uint8Array.from(text, c => c.charCodeAt(0))
const u16be = (v: number): number[] => [v >> 8, v & 0xff]
const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const u32le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
const toAscii = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	outer: for (let i = from; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				continue outer
			}
		}

		return i
	}

	return -1
}

// ── TIFF builder (both byte orders) ──────────────────────────────────────────

interface Entry {
	tag: number
	type: number
	// Inline SHORT/LONG value, or out-of-line bytes (type BYTE/ASCII/UNDEFINED, count = length).
	value: number | Uint8Array
}

interface TiffSpec {
	ifd0: Entry[]
	exif?: Entry[]
	ifd1?: Entry[]
	thumbnail?: Uint8Array
}

// Header, IFD0 (+ its data), Exif IFD, IFD1, thumbnail: a camera's usual layout, every offset from the header.
function buildTiff(le: boolean, spec: TiffSpec): Uint8Array {
	const bytes: number[] = []
	const put16 = (at: number, v: number) => {
		bytes[at] = le ? v & 0xff : v >> 8
		bytes[at + 1] = le ? v >> 8 : v & 0xff
	}
	const put32 = (at: number, v: number) => {
		const b = le ? u32le(v) : u32be(v)

		for (let i = 0; i < 4; i++) {
			bytes[at + i] = b[i] ?? 0
		}
	}
	const pad = () => {
		if (bytes.length % 2 === 1) {
			bytes.push(0)
		}
	}

	bytes.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), 0, 0, 0, 0, 0, 0)
	put16(2, 42)

	// Writes an IFD at the current end; returns [ifd offset, next-pointer offset, entry offsets by tag].
	const writeIfd = (entries: Entry[]): [number, number, Map<number, number>] => {
		pad()

		const ifd = bytes.length
		const sorted = [...entries].sort((a, b) => a.tag - b.tag)
		const offsets = new Map<number, number>()

		bytes.length += 2 + sorted.length * 12 + 4
		bytes.fill(0, ifd)
		put16(ifd, sorted.length)

		sorted.forEach((entry, i) => {
			const at = ifd + 2 + i * 12

			offsets.set(entry.tag, at)
			put16(at, entry.tag)
			put16(at + 2, entry.type)

			if (typeof entry.value === "number") {
				put32(at + 4, 1)

				if (entry.type === 3) {
					put16(at + 8, entry.value)
				} else {
					put32(at + 8, entry.value)
				}
			} else {
				put32(at + 4, entry.value.length)

				if (entry.value.length <= 4) {
					entry.value.forEach((b, j) => (bytes[at + 8 + j] = b))
				} else {
					pad()
					put32(at + 8, bytes.length)
					bytes.push(...entry.value)
				}
			}
		})

		return [ifd, ifd + 2 + sorted.length * 12, offsets]
	}

	const ifd0Entries = [...spec.ifd0]

	if (spec.exif !== undefined) {
		ifd0Entries.push({ tag: 0x8769, type: 4, value: 0 })
	}

	const [ifd0, ifd0Next, ifd0Offsets] = writeIfd(ifd0Entries)

	put32(4, ifd0)

	if (spec.exif !== undefined) {
		const [exifIfd] = writeIfd(spec.exif)

		put32((ifd0Offsets.get(0x8769) ?? 0) + 8, exifIfd)
	}

	if (spec.ifd1 !== undefined) {
		const thumbnail = spec.thumbnail ?? new Uint8Array(0)
		const [ifd1, , ifd1Offsets] = writeIfd([
			...spec.ifd1,
			{ tag: 0x0201, type: 4, value: 0 },
			{ tag: 0x0202, type: 4, value: thumbnail.length }
		])

		put32(ifd0Next, ifd1)
		pad()
		put32((ifd1Offsets.get(0x0201) ?? 0) + 8, bytes.length)
		bytes.push(...thumbnail)
	}

	return Uint8Array.from(bytes, b => b)
}

// A minimal TIFF reader for assertions, independent of the code under test.
function readTiff(tiff: Uint8Array) {
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
	const le = view.getUint16(0) === 0x4949
	const ifd0 = view.getUint32(4, le)
	const entries = (ifd: number) => {
		const out = new Map<number, { type: number; count: number; value: number; at: number }>()
		const count = view.getUint16(ifd, le)

		for (let i = 0; i < count; i++) {
			const at = ifd + 2 + i * 12
			const type = view.getUint16(at + 2, le)

			out.set(view.getUint16(at, le), {
				type,
				count: view.getUint32(at + 4, le),
				value: type === 3 ? view.getUint16(at + 8, le) : view.getUint32(at + 8, le),
				at
			})
		}

		return { out, next: view.getUint32(ifd + 2 + count * 12, le), tags: [...out.keys()] }
	}

	return { le, ifd0, entries }
}

const MAKE = ascii("Filen Test\0")

function cameraExif(le: boolean, withOrientation: number | null): Uint8Array {
	return buildTiff(le, {
		ifd0: [
			...(withOrientation === null ? [] : [{ tag: 0x0112, type: 3, value: withOrientation }]),
			{ tag: 0x010f, type: 2, value: MAKE }
		],
		exif: [
			{ tag: 0xa002, type: 3, value: 4000 },
			{ tag: 0xa003, type: 4, value: 3000 }
		],
		ifd1: [{ tag: 0x0103, type: 3, value: 6 }],
		thumbnail: new Uint8Array(64).fill(0xab)
	})
}

// ── JPEG builder ─────────────────────────────────────────────────────────────

function segment(marker: number, payload: Uint8Array | readonly number[]): Uint8Array {
	const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload)

	return concat([0xff, marker, ...u16be(body.length + 2)], body)
}

const APP0_JFIF = segment(0xe0, concat(ascii("JFIF\0"), [1, 2, 0, 0, 1, 0, 1, 0, 0]))
const exifSegment = (tiff: Uint8Array) => segment(0xe1, concat(ascii("Exif\0\0"), tiff))
const iccSegment = (sequence: number, count: number, data: Uint8Array) =>
	segment(0xe2, concat(ascii("ICC_PROFILE\0"), [sequence, count], data))
const xmpSegment = (xml: string) => segment(0xe1, concat(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(xml)))
const sof0 = (width: number, height: number) => segment(0xc0, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0])
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0])
const SCAN = Uint8Array.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9])

// T.81 Annex K.1 Table K.1.
const K1 = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
	37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
]

// libjpeg's jpeg_quality_scaling + jpeg_add_quant_table with force_baseline, written zig-zag as a DQT stores it:
// walk the anti-diagonals, alternating direction (T.81 Figure A.6).
function ijgTable(quality: number): number[] {
	const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2
	const natural = K1.map(base => Math.min(255, Math.max(1, Math.floor((base * scale + 50) / 100))))
	const zigzag: number[] = []

	for (let d = 0; d < 15; d++) {
		for (let i = 0; i <= d; i++) {
			const row = d % 2 === 0 ? d - i : i
			const col = d - row

			if (row < 8 && col < 8) {
				zigzag.push(natural[row * 8 + col] ?? 0)
			}
		}
	}

	return zigzag
}

const dqt = (quality: number) => segment(0xdb, [0x00, ...ijgTable(quality)])

function jpeg(...segments: Uint8Array[]): Uint8Array {
	return concat([0xff, 0xd8], ...segments, SOS, SCAN)
}

function headOf(file: Uint8Array): Uint8Array {
	return file.subarray(0, indexOf(file, Uint8Array.from([0xff, 0xda])))
}

function segmentsOf(file: Uint8Array): { marker: number; payload: Uint8Array }[] {
	const out: { marker: number; payload: Uint8Array }[] = []

	walkJpegSegments(file, s => {
		out.push({ marker: s.marker, payload: file.subarray(s.payloadStart, s.end) })

		return s.marker !== 0xda
	})

	return out
}

// ── JPEG sniff ───────────────────────────────────────────────────────────────

describe("sniffImage — JPEG", () => {
	for (const le of [true, false]) {
		it(`reads size, orientation, Exif and quality (${le ? "II" : "MM"})`, () => {
			const tiff = cameraExif(le, 6)
			const file = jpeg(APP0_JFIF, exifSegment(tiff), dqt(85), sof0(640, 480))
			const info = sniffImage(file, file.length)

			expect(info).toMatchObject({
				mime: "image/jpeg",
				width: 480,
				height: 640,
				orientation: 6,
				jpegQuality: 85,
				hasAlpha: false,
				icc: null
			})
			expect(info?.exif).toEqual(tiff)
			// Copied out, not a view onto the head.
			expect(info?.exif?.buffer).not.toBe(file.buffer)
		})
	}

	it("estimates every IJG quality within one step", () => {
		for (let quality = 1; quality <= 100; quality++) {
			const file = jpeg(dqt(quality), sof0(8, 8))
			const estimate = sniffImage(file, file.length)?.jpegQuality ?? 0

			expect(Math.abs(estimate - quality)).toBeLessThanOrEqual(1)
		}
	})

	it("reassembles ICC chunks by sequence number, and drops an incomplete profile", () => {
		const profile = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff)
		const whole = jpeg(iccSegment(2, 2, profile.subarray(150)), iccSegment(1, 2, profile.subarray(0, 150)), sof0(8, 8))

		expect(sniffImage(whole, whole.length)?.icc).toEqual(profile)

		const missing = jpeg(iccSegment(1, 2, profile.subarray(0, 150)), sof0(8, 8))

		expect(sniffImage(missing, missing.length)?.icc).toBeNull()
	})

	it("accepts the Exif\\0\\xFF identifier and fill bytes before a marker", () => {
		const tiff = cameraExif(true, 3)
		const exif = segment(0xe1, concat(ascii("Exif\0"), [0xff], tiff))
		const file = concat([0xff, 0xd8], exif, [0xff, 0xff], sof0(20, 10), SOS, SCAN)

		expect(sniffImage(file, file.length)).toMatchObject({ width: 20, height: 10, orientation: 3 })
	})

	it("gives up when the head ends before a frame header", () => {
		const file = jpeg(exifSegment(cameraExif(true, 1)), sof0(8, 8))

		expect(sniffImage(file.subarray(0, 30), file.length)).toBeNull()
	})
})

// ── buildJpeg ────────────────────────────────────────────────────────────────

describe("buildJpeg", () => {
	const encoded = jpeg(APP0_JFIF, segment(0xe1, ascii("Exif\0\0junk")), dqt(90), sof0(100, 50))

	for (const le of [true, false]) {
		it(`writes normalised Exif then ICC before the encoder's segments (${le ? "II" : "MM"})`, () => {
			const exif = cameraExif(le, 8)
			const exifCopy = exif.slice()
			const icc = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff)
			const out = buildJpeg(encoded, { exif, icc, width: 100, height: 50 })
			const segments = segmentsOf(out)

			expect(segments.map(s => s.marker)).toEqual([0xe1, 0xe2, 0xdb, 0xc0, 0xda])
			expect(exif).toEqual(exifCopy)

			const tiff = segments[0]?.payload.subarray(6) ?? new Uint8Array()
			const read = readTiff(tiff)
			const ifd0 = read.entries(read.ifd0)

			expect(ifd0.out.get(0x0112)?.value).toBe(1)
			expect(ifd0.next).toBe(0)
			// The trailing IFD1 and its thumbnail are cut off.
			expect(tiff.length).toBeLessThan(exif.length - 64)
			expect(toAscii(tiff.subarray(ifd0.out.get(0x010f)?.value ?? 0).subarray(0, MAKE.length))).toBe(toAscii(MAKE))

			const exifIfd = read.entries(ifd0.out.get(0x8769)?.value ?? 0)

			expect(exifIfd.out.get(0xa002)?.value).toBe(100)
			expect(exifIfd.out.get(0xa003)?.value).toBe(50)
			expect(segments[1]?.payload.subarray(12, 14)).toEqual(Uint8Array.from([1, 1]))
			expect(segments[1]?.payload.subarray(14)).toEqual(icc)
			// The scan is untouched.
			expect(out.subarray(out.length - SCAN.length)).toEqual(SCAN)
		})
	}

	it("splits a large profile into 65519-byte chunks numbered 1..n", () => {
		const icc = new Uint8Array(65519 * 2 + 10).map((_, i) => i & 0xff)
		const segments = segmentsOf(buildJpeg(encoded, { exif: null, icc, width: 100, height: 50 })).filter(s => s.marker === 0xe2)

		expect(segments.map(s => [s.payload[12], s.payload[13], s.payload.length - 14])).toEqual([
			[1, 3, 65519],
			[2, 3, 65519],
			[3, 3, 10]
		])
		expect(concat(...segments.map(s => s.payload.subarray(14)))).toEqual(icc)
	})

	it("drops Exif too large for one segment, and writes a bare file without metadata", () => {
		const huge = buildTiff(true, { ifd0: [{ tag: 0x010e, type: 7, value: new Uint8Array(70000) }] })

		expect(segmentsOf(buildJpeg(encoded, { exif: huge, icc: null, width: 1, height: 1 })).map(s => s.marker)).toEqual([
			0xdb, 0xc0, 0xda
		])
	})

	it("widens a SHORT dimension that no longer fits", () => {
		const exif = cameraExif(false, null)
		const out = buildJpeg(encoded, { exif, icc: null, width: 70000, height: 50 })
		const tiff = segmentsOf(out)[0]?.payload.subarray(6) ?? new Uint8Array()
		const read = readTiff(tiff)
		const exifIfd = read.entries(read.entries(read.ifd0).out.get(0x8769)?.value ?? 0)

		expect(exifIfd.out.get(0xa002)).toMatchObject({ type: 4, value: 70000 })
		// No Orientation was there; none is added.
		expect(read.entries(read.ifd0).out.has(0x0112)).toBe(false)
	})
})

describe("normalizeExif", () => {
	it("keeps the dead bytes when IFD1 is not at the tail", () => {
		const tiff = cameraExif(true, 6)
		// Move nothing; instead append bytes past the thumbnail that nothing references: the cut must not happen.
		const padded = concat(tiff, new Uint8Array(20))
		const out = normalizeExif(padded, null)

		expect(out?.length).toBe(padded.length)
		expect(readExifOrientation(out ?? new Uint8Array())).toBe(1)
	})

	it("rejects a non-TIFF block", () => {
		expect(normalizeExif(ascii("not a tiff block"), null)).toBeNull()
	})
})

// ── rewriteOrientationHead ───────────────────────────────────────────────────

describe("rewriteOrientationHead", () => {
	function rewritten(file: Uint8Array, orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) {
		const head = headOf(file)
		const before = head.slice()
		const result = rewriteOrientationHead(head, orientation)

		expect(head).toEqual(before)

		if (result === null) {
			throw new Error("rewrite failed")
		}

		expect(result.delta).toBe(result.head.length - head.length)

		const whole = concat(result.head, file.subarray(head.length))

		return { result, whole, info: sniffImage(whole, whole.length) }
	}

	for (const le of [true, false]) {
		it(`rewrites a present tag in place (${le ? "II" : "MM"})`, () => {
			const file = jpeg(APP0_JFIF, exifSegment(cameraExif(le, 1)), sof0(30, 20))
			const { result, info } = rewritten(file, 6)

			expect(result.delta).toBe(0)
			expect(info).toMatchObject({ orientation: 6, width: 20, height: 30 })
		})

		it(`adds the tag to IFD0 when absent, keeping IFD1 and every other tag (${le ? "II" : "MM"})`, () => {
			const tiff = cameraExif(le, null)
			const file = jpeg(exifSegment(tiff), sof0(30, 20))
			const { result, info } = rewritten(file, 8)

			expect(result.delta).toBeGreaterThan(0)
			expect(info?.orientation).toBe(8)

			const exif = info?.exif ?? new Uint8Array()
			const read = readTiff(exif)
			const ifd0 = read.entries(read.ifd0)

			// Sorted, the old entries carried over.
			expect(ifd0.tags).toEqual([0x010f, 0x0112, 0x8769])
			expect(toAscii(exif.subarray(ifd0.out.get(0x010f)?.value ?? 0).subarray(0, MAKE.length))).toBe(toAscii(MAKE))
			expect(read.entries(ifd0.out.get(0x8769)?.value ?? 0).out.get(0xa002)?.value).toBe(4000)

			// IFD1 still chained and its thumbnail intact.
			const ifd1 = read.entries(ifd0.next)

			expect(exif.subarray(ifd1.out.get(0x0201)?.value ?? 0).subarray(0, 64)).toEqual(new Uint8Array(64).fill(0xab))
			// The segment length field grew with it.
			expect(segmentsOf(result.head)[0]?.payload.length).toBe(6 + exif.length)
		})
	}

	it("leaves a file without Orientation alone when 1 is asked", () => {
		const file = jpeg(exifSegment(cameraExif(true, null)), sof0(30, 20))
		const head = headOf(file)

		expect(rewriteOrientationHead(head, 1)).toEqual({ head, delta: 0 })
	})

	it("inserts a minimal Exif after the JFIF APP0", () => {
		const file = jpeg(APP0_JFIF, dqt(80), sof0(30, 20))
		const { result, info } = rewritten(file, 6)

		expect(segmentsOf(result.head).map(s => s.marker)).toEqual([0xe0, 0xe1, 0xdb, 0xc0])
		expect(info).toMatchObject({ orientation: 6, width: 20, height: 30 })
	})

	it("inserts a minimal Exif right after SOI without JFIF", () => {
		const file = jpeg(dqt(80), sof0(30, 20))
		const { result, info } = rewritten(file, 3)

		expect(segmentsOf(result.head).map(s => s.marker)).toEqual([0xe1, 0xdb, 0xc0])
		expect(info?.orientation).toBe(3)
	})

	it("matches XMP tiff:Orientation, attribute and element forms", () => {
		const attribute = `<x:xmpmeta><rdf:Description tiff:Orientation="1" tiff:Make="x"/></x:xmpmeta>`
		const element = `<x:xmpmeta><tiff:Orientation>1</tiff:Orientation></x:xmpmeta>`
		const file = jpeg(exifSegment(cameraExif(true, 1)), xmpSegment(attribute), xmpSegment(element), sof0(30, 20))
		const { result } = rewritten(file, 6)
		const xmps = segmentsOf(result.head)
			.filter(s => s.marker === 0xe1)
			.slice(1)
			.map(s => toAscii(s.payload))

		expect(result.delta).toBe(0)
		expect(xmps[0]).toContain(`tiff:Orientation="6"`)
		expect(xmps[1]).toContain(`<tiff:Orientation>6</tiff:Orientation>`)
	})

	it("blanks an XMP value it cannot rewrite at the same length", () => {
		const xml = `<rdf:Description tiff:Orientation="01" a="b"/>`
		const file = jpeg(xmpSegment(xml), sof0(30, 20))
		const { result } = rewritten(file, 6)
		const xmp = toAscii(segmentsOf(result.head)[1]?.payload ?? new Uint8Array())

		expect(xmp).not.toContain("tiff:Orientation")
		expect(xmp).toContain(`<rdf:Description ${" ".repeat(`tiff:Orientation="01"`.length)} a="b"/>`)
	})

	it("refuses a head cut inside a segment, or not a JPEG", () => {
		const file = jpeg(exifSegment(cameraExif(true, 1)), sof0(30, 20))

		expect(rewriteOrientationHead(file.subarray(0, 20), 6)).toBeNull()
		expect(rewriteOrientationHead(ascii("nope"), 6)).toBeNull()
	})

	it("passes everything from SOS on through untouched", () => {
		const file = jpeg(exifSegment(cameraExif(true, 1)), sof0(30, 20))
		const result = rewriteOrientationHead(file, 5)

		expect(result?.head.subarray((result.head.length || 0) - SOS.length - SCAN.length)).toEqual(concat(SOS, SCAN))
	})

	it("refuses to grow an Exif segment past 65535 bytes", () => {
		const tiff = buildTiff(true, { ifd0: [{ tag: 0x010e, type: 7, value: new Uint8Array(65520) }] })
		const file = jpeg(exifSegment(tiff), sof0(30, 20))

		expect(rewriteOrientationHead(headOf(file), 6)).toBeNull()
	})
})

// ── PNG ──────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Uint8Array | readonly number[]): Uint8Array {
	const body = data instanceof Uint8Array ? data : Uint8Array.from(data)

	return concat(u32be(body.length), ascii(type), body, u32be(zlibCrc32(concat(ascii(type), body))))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ihdr = (width: number, height: number, bitDepth: number, colourType: number) =>
	chunk("IHDR", [...u32be(width), ...u32be(height), bitDepth, colourType, 0, 0, 0])
const IDAT = chunk("IDAT", [0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])
const IEND = chunk("IEND", [])

function png(...chunks: Uint8Array[]): Uint8Array {
	return concat(PNG_SIGNATURE, ...chunks)
}

function chunksOf(file: Uint8Array): { type: string; data: Uint8Array; crc: number }[] {
	const out: { type: string; data: Uint8Array; crc: number }[] = []
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength)

	walkPngChunks(file, c => {
		out.push({
			type: toAscii(file.subarray(c.start + 4, c.data)),
			data: file.subarray(c.data, c.end - 4),
			crc: view.getUint32(c.end - 4)
		})

		return true
	})

	return out
}

describe("sniffImage — PNG", () => {
	it("classifies colour type and bit depth", () => {
		const rgba8 = png(ihdr(4, 3, 8, 6), IDAT, IEND)
		const rgb16 = png(ihdr(4, 3, 16, 2), IDAT, IEND)
		const palette = png(ihdr(4, 3, 8, 3), chunk("PLTE", [0, 0, 0]), chunk("tRNS", [0]), IDAT, IEND)
		const grey = png(ihdr(4, 3, 8, 0), IDAT, IEND)

		expect(sniffImage(rgba8, rgba8.length)).toMatchObject({
			mime: "image/png",
			width: 4,
			height: 3,
			hasAlpha: true,
			pngTruecolor8: true
		})
		expect(sniffImage(rgb16, rgb16.length)).toMatchObject({ hasAlpha: false, pngTruecolor8: false })
		expect(sniffImage(palette, palette.length)).toMatchObject({ hasAlpha: true, pngTruecolor8: false })
		expect(sniffImage(grey, grey.length)).toMatchObject({ hasAlpha: false, pngTruecolor8: false })
	})

	it("counts acTL only before the first IDAT", () => {
		const apng = png(ihdr(4, 3, 8, 6), chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]), IDAT, IEND)
		const late = png(ihdr(4, 3, 8, 6), IDAT, chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]), IEND)

		expect(sniffImage(apng, apng.length)?.animated).toBe(true)
		expect(sniffImage(late, late.length)?.animated).toBe(false)
	})

	it("keeps the raw iCCP data and the eXIf block, applying its orientation to the size", () => {
		const iccp = concat(ascii("Display P3\0"), [0], [0x78, 0x9c, 1, 2, 3])
		const exif = cameraExif(false, 6)
		const file = png(ihdr(4, 3, 8, 2), chunk("iCCP", iccp), chunk("eXIf", exif), IDAT, IEND)

		expect(sniffImage(file, file.length)).toMatchObject({ icc: iccp, exif, orientation: 6, width: 3, height: 4 })
	})

	it("rejects a file whose first chunk is not IHDR", () => {
		const file = png(IDAT, ihdr(4, 3, 8, 2), IEND)

		expect(sniffImage(file, file.length)).toBeNull()
	})
})

describe("buildPng / pngChunk", () => {
	it("writes chunks with a correct CRC", () => {
		expect(pngChunk("IEND", new Uint8Array())).toEqual(IEND)
		expect(pngChunk("tEXt", ascii("a\0b"))).toEqual(chunk("tEXt", ascii("a\0b")))
	})

	it("drops the encoder's colour chunks, puts iCCP after IHDR and eXIf before IDAT", () => {
		const encoded = png(ihdr(7, 5, 8, 6), chunk("sRGB", [0]), chunk("gAMA", u32be(45455)), IDAT, IDAT, IEND)
		const iccp = concat(ascii("p\0"), [0], [1, 2, 3])
		const exif = cameraExif(true, 6)
		const out = buildPng(encoded, { icc: iccp, exif })
		const chunks = chunksOf(out)

		expect(chunks.map(c => c.type)).toEqual(["IHDR", "iCCP", "eXIf", "IDAT", "IDAT", "IEND"])

		for (const c of chunks) {
			expect(c.crc).toBe(zlibCrc32(concat(ascii(c.type), c.data)))
		}

		expect(chunks[1]?.data).toEqual(iccp)

		const tiff = chunks[2]?.data ?? new Uint8Array()
		const read = readTiff(tiff)

		expect(read.entries(read.ifd0).out.get(0x0112)?.value).toBe(1)
		expect(read.entries(read.ifd0).next).toBe(0)
		expect(read.entries(read.entries(read.ifd0).out.get(0x8769)?.value ?? 0).out.get(0xa002)?.value).toBe(7)
	})

	it("passes the encoder's chunks through without metadata", () => {
		const encoded = png(ihdr(7, 5, 8, 2), IDAT, IEND)

		expect(buildPng(encoded, { icc: null, exif: null })).toEqual(encoded)
	})
})

// ── WebP ─────────────────────────────────────────────────────────────────────

function riffChunk(type: string, data: Uint8Array | readonly number[]): Uint8Array {
	const body = data instanceof Uint8Array ? data : Uint8Array.from(data)

	return concat(ascii(type), u32le(body.length), body, body.length % 2 === 1 ? [0] : [])
}

function webp(...chunks: Uint8Array[]): Uint8Array {
	const body = concat(ascii("WEBP"), ...chunks)

	return concat(ascii("RIFF"), u32le(body.length), body)
}

// A VP8 key frame header: frame tag, start code, 14-bit sizes (RFC 6386 §9.1), then filler.
const vp8 = (width: number, height: number) =>
	riffChunk("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0])

function vp8l(width: number, height: number, alpha: boolean): Uint8Array {
	const bits = ((width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0)) >>> 0

	return riffChunk("VP8L", [0x2f, ...u32le(bits), 0])
}

function vp8x(flags: number, width: number, height: number): Uint8Array {
	const w = width - 1
	const h = height - 1

	return riffChunk("VP8X", [flags, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, w >> 16, h & 0xff, (h >> 8) & 0xff, h >> 16])
}

function riffChunksOf(file: Uint8Array): { type: string; size: number }[] {
	const out: { type: string; size: number }[] = []

	walkWebpChunks(file, c => {
		out.push({ type: toAscii(file.subarray(c.start, c.start + 4)), size: c.size })

		return true
	})

	return out
}

describe("sniffImage — WebP", () => {
	it("reads simple lossy and lossless files", () => {
		const lossy = webp(vp8(300, 200))
		const lossless = webp(vp8l(300, 200, true))

		expect(sniffImage(lossy, lossy.length)).toMatchObject({
			mime: "image/webp",
			width: 300,
			height: 200,
			hasAlpha: false,
			webpLossless: false
		})
		expect(sniffImage(lossless, lossless.length)).toMatchObject({ width: 300, height: 200, hasAlpha: true, webpLossless: true })
	})

	it("reads VP8X with ICC, ALPH and Exif", () => {
		const icc = Uint8Array.from([1, 2, 3, 4, 5])
		const exif = cameraExif(true, 1)
		const file = webp(
			vp8x(0x20 | 0x10 | 0x08, 70000, 3),
			riffChunk("ICCP", icc),
			riffChunk("ALPH", [0]),
			vp8(1, 3),
			riffChunk("EXIF", exif)
		)

		expect(sniffImage(file, file.length)).toMatchObject({
			width: 70000,
			height: 3,
			hasAlpha: true,
			icc,
			exif,
			needsTail: false,
			animated: false
		})
	})

	it("strips a JPEG-style Exif prefix", () => {
		const exif = cameraExif(false, 1)
		const file = webp(vp8x(0x08, 3, 3), vp8(3, 3), riffChunk("EXIF", concat(ascii("Exif\0\0"), exif)))

		expect(sniffImage(file, file.length)?.exif).toEqual(exif)
	})

	it("flags a tail read when Exif lies past the head", () => {
		const file = webp(vp8x(0x08, 3, 3), vp8(3, 3), riffChunk("EXIF", cameraExif(true, 1)))
		const head = file.subarray(0, 12 + 18 + 22)

		expect(sniffImage(head, file.length)).toMatchObject({ needsTail: true, exif: null })
	})

	it("reports animation", () => {
		const file = webp(vp8x(0x02, 3, 3), riffChunk("ANIM", [0, 0, 0, 0, 0, 0]), riffChunk("ANMF", new Uint8Array(16)))

		expect(sniffImage(file, file.length)?.animated).toBe(true)
	})
})

describe("buildWebp", () => {
	it("returns the encoder's file untouched without metadata", () => {
		const encoded = webp(vp8(3, 3))

		expect(buildWebp(encoded, { icc: null, exif: null, width: 3, height: 3, hasAlpha: false })).toBe(encoded)
	})

	it("converts to VP8X with chunks in container order, odd chunks padded, RIFF size right", () => {
		const encoded = webp(vp8x(0x10, 5, 4), riffChunk("ALPH", [1, 2, 3]), vp8(5, 4))
		const icc = Uint8Array.from([9, 9, 9])
		const exif = cameraExif(true, 6)
		const out = buildWebp(encoded, { icc, exif, width: 5, height: 4, hasAlpha: true })
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength)

		expect(view.getUint32(4, true)).toBe(out.length - 8)
		expect(out.length % 2).toBe(0)
		expect(riffChunksOf(out).map(c => c.type)).toEqual(["VP8X", "ICCP", "ALPH", "VP8 ", "EXIF"])
		// I, L and E flags; canvas 5×4 stored minus one.
		expect(out[20]).toBe(0x20 | 0x10 | 0x08)
		expect([...out.subarray(24, 30)]).toEqual([4, 0, 0, 3, 0, 0])

		const info = sniffImage(out, out.length)

		expect(info).toMatchObject({ width: 5, height: 4, hasAlpha: true, icc, orientation: 1 })
	})

	it("sets no alpha flag for an opaque lossless image", () => {
		const out = buildWebp(webp(vp8l(5, 4, false)), { icc: Uint8Array.from([1]), exif: null, width: 5, height: 4, hasAlpha: false })

		expect(out[20]).toBe(0x20)
	})
})

// ── GIF / BMP / ICO ──────────────────────────────────────────────────────────

function gif(frames: number, options: { loop?: boolean; transparent?: boolean } = {}): Uint8Array {
	const header = concat(ascii("GIF89a"), [10, 0, 8, 0, 0x80, 0, 0], new Uint8Array(6))
	const loop = options.loop === true ? concat([0x21, 0xff, 11], ascii("NETSCAPE2.0"), [3, 1, 0, 0, 0]) : new Uint8Array()
	const frame = concat(
		[0x21, 0xf9, 4, options.transparent === true ? 1 : 0, 0, 0, 0, 0],
		[0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0],
		[2, 2, 0x4c, 0x01, 0]
	)

	return concat(header, loop, ...Array.from({ length: frames }, () => frame), [0x3b])
}

describe("sniffImage — GIF, BMP, ICO", () => {
	it("counts GIF frames", () => {
		const still = gif(1, { transparent: true })
		const animated = gif(2)

		expect(sniffImage(still, still.length)).toMatchObject({ mime: "image/gif", width: 10, height: 8, animated: false, hasAlpha: true })
		expect(sniffImage(animated, animated.length)?.animated).toBe(true)
	})

	it("treats a looping GIF read only in part as animated", () => {
		const file = gif(3, { loop: true })
		const head = file.subarray(0, 40)

		expect(sniffImage(head, file.length)?.animated).toBe(true)
		expect(sniffImage(gif(1, { loop: true }), gif(1, { loop: true }).length)?.animated).toBe(false)
	})

	it("reads BMP size and a BITFIELDS alpha mask", () => {
		const bmp = (bitCount: number, compression: number, alphaMask: number) => {
			const out = new Uint8Array(14 + 108)
			const view = new DataView(out.buffer)

			out.set(ascii("BM"))
			view.setUint32(14, 108, true)
			view.setInt32(18, 6, true)
			view.setInt32(22, -4, true)
			view.setUint16(28, bitCount, true)
			view.setUint32(30, compression, true)
			view.setUint32(66, alphaMask, true)

			return out
		}

		expect(sniffImage(bmp(32, 3, 0xff000000), 122)).toMatchObject({ mime: "image/bmp", width: 6, height: 4, hasAlpha: true })
		expect(sniffImage(bmp(32, 0, 0), 122)?.hasAlpha).toBe(false)
		expect(sniffImage(bmp(24, 3, 0xff000000), 122)?.hasAlpha).toBe(false)
	})

	it("picks the largest ICO entry", () => {
		const ico = concat([0, 0, 1, 0, 2, 0], [16, 16, 0, 0, 1, 0, 32, 0], new Uint8Array(8), [0, 0, 0, 0, 1, 0, 32, 0], new Uint8Array(8))

		expect(sniffImage(ico, ico.length)).toMatchObject({ mime: "image/x-icon", width: 256, height: 256, hasAlpha: true })
	})

	it("returns null for unknown bytes", () => {
		expect(sniffImage(ascii("hello world, not an image"), 25)).toBeNull()
	})
})

// ── HEIF / AVIF ──────────────────────────────────────────────────────────────

function box(type: string, ...content: (Uint8Array | readonly number[])[]): Uint8Array {
	const body = concat(...content)

	return concat(u32be(body.length + 8), ascii(type), body)
}

const fullBox = (type: string, version: number, flags: number, ...content: (Uint8Array | readonly number[])[]) =>
	box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...content)

interface HeifSpec {
	major: string
	compatible: string[]
	primaryType: string
	icc?: Uint8Array
	nclx?: boolean
	irot?: number
	alpha?: boolean
	exif?: Uint8Array
	ilocVersion?: 0 | 1
	exifInIdat?: boolean
}

// ftyp, meta (pitm, iinf, iloc, iref, iprp, idat), mdat. Item 1 is the primary image, 2 the Exif, 3 the alpha plane.
function heif(spec: HeifSpec): Uint8Array {
	const ftyp = box("ftyp", ascii(spec.major), u32be(0), ...spec.compatible.map(ascii))
	const exifPayload = spec.exif === undefined ? null : concat(u32be(0), spec.exif)
	const items = [
		fullBox("infe", 2, 0, u16be(1), u16be(0), ascii(spec.primaryType), [0]),
		...(exifPayload === null ? [] : [fullBox("infe", 2, 0, u16be(2), u16be(0), ascii("Exif"), [0])]),
		...(spec.alpha === true ? [fullBox("infe", 2, 0, u16be(3), u16be(0), ascii(spec.primaryType), [0])] : [])
	]
	const properties: Uint8Array[] = [fullBox("ispe", 0, 0, u32be(1200), u32be(800))]
	const primaryProps = [1]

	if (spec.icc !== undefined) {
		properties.push(box("colr", ascii("prof"), spec.icc))
		primaryProps.push(properties.length)
	}

	if (spec.nclx === true) {
		properties.push(box("colr", ascii("nclx"), [0, 12, 0, 13, 0, 1, 0x80]))
		primaryProps.push(properties.length)
	}

	if (spec.irot !== undefined) {
		properties.push(box("irot", [spec.irot]))
		primaryProps.push(properties.length)
	}

	const alphaProps: number[] = []

	if (spec.alpha === true) {
		properties.push(fullBox("auxC", 0, 0, ascii("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0")))
		alphaProps.push(1, properties.length)
	}

	const ipma = fullBox(
		"ipma",
		0,
		0,
		u32be(spec.alpha === true ? 2 : 1),
		u16be(1),
		[primaryProps.length],
		primaryProps.map(i => 0x80 | i),
		...(spec.alpha === true ? [u16be(3), [alphaProps.length], alphaProps] : [])
	)

	const buildMeta = (exifOffset: number) => {
		const version = spec.ilocVersion ?? 0
		const method = spec.exifInIdat === true ? 1 : 0
		const location =
			exifPayload === null
				? []
				: [u16be(2), ...(version === 1 ? [u16be(method)] : []), u16be(0), u16be(1), u32be(exifOffset), u32be(exifPayload.length)]
		const iloc = fullBox("iloc", version, 0, [0x44, 0x00], u16be(exifPayload === null ? 0 : 1), ...location)

		return fullBox(
			"meta",
			0,
			0,
			fullBox("hdlr", 0, 0, u32be(0), ascii("pict"), new Uint8Array(13)),
			fullBox("pitm", 0, 0, u16be(1)),
			fullBox("iinf", 0, 0, u16be(items.length), ...items),
			iloc,
			...(spec.alpha === true ? [fullBox("iref", 0, 0, box("auxl", u16be(3), u16be(1), u16be(1)))] : []),
			box("iprp", box("ipco", ...properties), ipma),
			...(spec.exifInIdat === true && exifPayload !== null ? [box("idat", exifPayload)] : [])
		)
	}

	const mdatData = spec.exifInIdat === true || exifPayload === null ? new Uint8Array(4) : exifPayload
	const metaLength = buildMeta(0).length
	const meta = buildMeta(spec.exifInIdat === true ? 0 : ftyp.length + metaLength + 8)

	return concat(ftyp, meta, box("mdat", mdatData))
}

describe("HEIF / AVIF", () => {
	const exif = cameraExif(false, 6)
	const icc = Uint8Array.from({ length: 40 }, (_, i) => i)

	it("reads a HEIC: size with irot, ICC, Exif, no alpha", () => {
		const file = heif({ major: "heic", compatible: ["mif1", "heic"], primaryType: "hvc1", icc, irot: 1, exif })
		const info = sniffImage(file, file.length)

		expect(info).toMatchObject({
			mime: "image/heic",
			width: 800,
			height: 1200,
			hasAlpha: false,
			animated: false,
			orientation: 1,
			icc,
			exif
		})
		expect(heifExif(file)).toEqual(exif)
		expect(heifIcc(file)).toEqual(icc)
	})

	it("reads an AVIF with an alpha auxiliary image", () => {
		const file = heif({ major: "avif", compatible: ["mif1", "miaf"], primaryType: "av01", alpha: true })

		expect(sniffImage(file, file.length)).toMatchObject({
			mime: "image/avif",
			width: 1200,
			height: 800,
			hasAlpha: true,
			icc: null,
			exif: null
		})
	})

	it("tells AVIF from HEIC by the primary item type when only mif1 is declared", () => {
		const file = heif({ major: "mif1", compatible: ["mif1"], primaryType: "av01" })

		expect(sniffHeif(file)?.mime).toBe("image/avif")
	})

	it("flags sequence brands as animated", () => {
		for (const brand of ["avis", "msf1", "hevs"]) {
			const file = heif({ major: "mif1", compatible: [brand], primaryType: "hvc1" })

			expect(sniffHeif(file)?.animated).toBe(true)
		}
	})

	it("returns no ICC for an nclx colour description", () => {
		const file = heif({ major: "heic", compatible: ["mif1"], primaryType: "hvc1", nclx: true })

		expect(heifIcc(file)).toBeNull()
	})

	it("reads Exif through iloc version 1, from the file and from idat", () => {
		const fromFile = heif({ major: "heic", compatible: ["mif1"], primaryType: "hvc1", exif, ilocVersion: 1 })
		const fromIdat = heif({ major: "heic", compatible: ["mif1"], primaryType: "hvc1", exif, ilocVersion: 1, exifInIdat: true })

		expect(heifExif(fromFile)).toEqual(exif)
		expect(heifExif(fromIdat)).toEqual(exif)
	})

	it("gives null when the Exif lies past the bytes given, or the meta box is cut", () => {
		const file = heif({ major: "heic", compatible: ["mif1"], primaryType: "hvc1", exif })

		expect(heifExif(file.subarray(0, file.length - 10))).toBeNull()
		expect(sniffHeif(file.subarray(0, 60))).toBeNull()
	})
})
