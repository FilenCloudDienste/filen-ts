import { describe, expect, it } from "vitest"
import { bytesSource, ContentTypes, parseContentTypes, type ByteSource, type ZipEntry } from "@filen/office/core/opc"
import { strToU8 } from "fflate"
import { checkPackage, confirmMedia, imageDimensions, imageWithinBudget, MEDIA_LIMITS, sniffMedia } from "../core/opc/mediaPolicy"
import { openPptx } from "../core/pptx/package"
import { buildPptx, sp } from "./pptxFixtures"

// The package limits and media classes of presentations: hostile declared sizes are refused from the central
// directory, before any entry they describe is read; an entry is media only when a media relationship, an audio
// or video content type and (at first read) its container all agree.

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

// Rewrites the declared uncompressed size of `name` in both its local header and its central-directory record (a
// zip that lies about how large an entry inflates).
function declare(zip: Uint8Array, name: string, size: number): Uint8Array {
	const out = zip.slice()
	const view = new DataView(out.buffer)
	const wanted = strToU8(name)
	const matches = (at: number, nameAt: number, length: number): boolean =>
		length === wanted.length && wanted.every((byte, index) => out[nameAt + index] === byte) && at >= 0

	for (let at = 0; at + 46 <= out.length; at++) {
		const signature = view.getUint32(at, true)

		if (signature === 0x04034b50 && matches(at, at + 30, view.getUint16(at + 26, true))) view.setUint32(at + 22, size, true)
		if (signature === 0x02014b50 && matches(at, at + 46, view.getUint16(at + 28, true))) view.setUint32(at + 24, size, true)
	}

	return out
}

// A source that records the ranges it hands out.
function recorded(bytes: Uint8Array): ByteSource & { readonly ranges: [number, number][] } {
	const inner = bytesSource(bytes)
	const ranges: [number, number][] = []

	return {
		size: inner.size,
		read(offset, length) {
			ranges.push([offset, offset + length])

			return inner.read(offset, length)
		},
		ranges
	}
}

// Where an entry's data starts (after its local header and name).
function dataStart(zip: Uint8Array, name: string): number {
	const view = new DataView(zip.buffer)
	const wanted = strToU8(name)

	for (let at = 0; at + 30 <= zip.length; at++) {
		if (view.getUint32(at, true) !== 0x04034b50) continue

		const length = view.getUint16(at + 26, true)

		if (length === wanted.length && wanted.every((byte, index) => zip[at + 30 + index] === byte)) {
			return at + 30 + length + view.getUint16(at + 28, true)
		}
	}

	throw new Error(`no entry ${name}`)
}

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0, 0, 0, 0x02, 0
])
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0])

// Incompressible bytes after the media entry, so the reader's read of the archive's tail cannot reach it.
const PADDING = (() => {
	const bytes = new Uint8Array(256 * 1024)
	let state = 0x2545f491

	for (let index = 0; index < bytes.length; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		bytes[index] = state & 0xff
	}

	return bytes
})()

function mediaDeck(options: {
	readonly relType: string
	readonly target: string
	readonly data: Uint8Array
	readonly defaults: string
}): Uint8Array {
	return buildPptx({
		slides: [{ shapes: sp(2, "Media", undefined), rels: [["rId5", options.relType, `../media/${options.target}`]] }],
		parts: { [`ppt/media/${options.target}`]: { data: options.data }, "ppt/padding.bin": { data: PADDING } },
		defaults: options.defaults
	})
}

describe("presentation package limits", () => {
	it("refuses a 3 GiB image from its declared size without reading it", async () => {
		const zip = declare(
			mediaDeck({
				relType: "image",
				target: "image1.png",
				data: PNG,
				defaults: '<Default Extension="png" ContentType="image/png"/>'
			}),
			"ppt/media/image1.png",
			3 * GIB
		)
		const source = recorded(zip)
		const open = await openPptx(source)
		const start = dataStart(zip, "ppt/media/image1.png")

		expect(open).toMatchObject({ kind: "refused", reason: "tooLarge" })
		expect(open.kind === "refused" ? open.detail : "").toContain("ppt/media/image1.png (image)")
		// The image's bytes were never read: only the central directory and the parts the policy needs.
		expect(source.ranges.some(([from, to]) => from <= start && start < to)).toBe(false)
	})

	it("treats a video content type on an image relationship as no media, refused by the other-part limit", async () => {
		const zip = declare(
			mediaDeck({ relType: "image", target: "clip.mp4", data: MP4, defaults: '<Default Extension="mp4" ContentType="video/mp4"/>' }),
			"ppt/media/clip.mp4",
			300 * MIB
		)
		const open = await openPptx(bytesSource(zip))

		expect(open).toMatchObject({ kind: "refused", reason: "tooLarge" })
		expect(open.kind === "refused" ? open.detail : "").toContain("(other)")
	})

	it("treats a media relationship to an XML part as no media", async () => {
		const zip = declare(
			mediaDeck({ relType: "video", target: "clip.xml", data: strToU8("<x/>"), defaults: "" }),
			"ppt/media/clip.xml",
			100 * MIB
		)
		const open = await openPptx(bytesSource(zip))

		expect(open).toMatchObject({ kind: "refused", reason: "tooLarge" })
		expect(open.kind === "refused" ? open.detail : "").toContain("(other)")
	})

	it("lets a 3 GiB video through as media, outside the non-media total", async () => {
		const zip = declare(
			mediaDeck({ relType: "video", target: "clip.mp4", data: MP4, defaults: '<Default Extension="mp4" ContentType="video/mp4"/>' }),
			"ppt/media/clip.mp4",
			3 * GIB
		)
		const open = await openPptx(bytesSource(zip))

		if (open.kind !== "opened") throw new Error(open.reason)

		expect([...open.parts.media]).toEqual(["ppt/media/clip.mp4"])
		expect(open.parts.notices).toEqual([])
	})
})

function entry(name: string, size: number): ZipEntry {
	return {
		index: 0,
		name,
		nameBytes: strToU8(name),
		versionMadeBy: 20,
		versionNeeded: 20,
		flags: 0,
		method: 0,
		modTime: 0,
		modDate: 0,
		crc32: 0,
		compressedSize: size,
		uncompressedSize: size,
		localHeaderOffset: 0,
		internalAttributes: 0,
		externalAttributes: 0,
		extra: new Uint8Array(0),
		zip64Fields: 0,
		comment: new Uint8Array(0)
	}
}

const TYPES: ContentTypes = parseContentTypes(
	strToU8(
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>' +
			'<Default Extension="png" ContentType="image/png"/><Default Extension="mp4" ContentType="video/mp4"/><Default Extension="bin" ContentType="application/octet-stream"/></Types>'
	)
)

describe("checkPackage", () => {
	it("classes media, images and other parts with their own limits", () => {
		const media = new Set(["ppt/media/a.mp4"])

		expect(checkPackage([entry("ppt/media/a.mp4", 4 * GIB + 1)], TYPES, media)).toMatchObject({ kind: "tooLarge", class: "media" })
		expect(checkPackage([entry("ppt/media/a.mp4", 4 * GIB)], TYPES, media)).toMatchObject({ kind: "ok", nonMediaBytes: 0 })
		expect(checkPackage([entry("ppt/media/b.png", 256 * MIB + 1)], TYPES, media)).toMatchObject({ kind: "tooLarge", class: "image" })
		expect(checkPackage([entry("ppt/media/b.png", 256 * MIB)], TYPES, media)).toMatchObject({ kind: "ok" })
		expect(checkPackage([entry("ppt/embeddings/c.bin", 64 * MIB + 1)], TYPES, media)).toMatchObject({
			kind: "tooLarge",
			class: "other"
		})
		expect(checkPackage([entry("ppt/slides/slide1.xml", 64 * MIB + 1)], TYPES, media)).toMatchObject({
			kind: "tooLarge",
			class: "other"
		})
	})

	it("refuses images and other parts past 512 MiB together", () => {
		const entries = [entry("a.png", 200 * MIB), entry("b.png", 200 * MIB), entry("c.png", 200 * MIB)]

		expect(checkPackage(entries, TYPES, new Set())).toMatchObject({
			kind: "tooLarge",
			class: "total",
			limit: MEDIA_LIMITS.nonMediaTotal
		})
		expect(checkPackage(entries.slice(0, 2), TYPES, new Set())).toMatchObject({ kind: "ok", nonMediaBytes: 400 * MIB })
	})

	it("gives a notice for media without a relationship and a relationship without a media type", () => {
		const verdict = checkPackage([entry("ppt/media/a.mp4", 10), entry("ppt/media/b.png", 10)], TYPES, new Set(["ppt/media/b.png"]))

		expect(verdict).toMatchObject({
			kind: "ok",
			media: new Set(),
			notices: [
				{ kind: "unreferencedMedia", part: "ppt/media/a.mp4" },
				{ kind: "notMediaType", part: "ppt/media/b.png" }
			]
		})
	})
})

describe("media sniffing", () => {
	const head = (...parts: (string | readonly number[])[]): Uint8Array => {
		const bytes: number[] = []

		for (const part of parts) {
			if (typeof part === "string") for (const char of part) bytes.push(char.charCodeAt(0))
			else bytes.push(...part)
		}

		while (bytes.length < 16) bytes.push(0)

		return Uint8Array.from(bytes)
	}

	it.each([
		["isoBmff", head([0, 0, 0, 0x18], "ftypisom")],
		["isoBmff", head([0, 0, 0, 8], "moov")],
		["matroska", head([0x1a, 0x45, 0xdf, 0xa3])],
		["ogg", head("OggS")],
		["wav", head("RIFF", [0, 0, 0, 0], "WAVE")],
		["avi", head("RIFF", [0, 0, 0, 0], "AVI ")],
		["aiff", head("FORM", [0, 0, 0, 0], "AIFF")],
		["asf", head([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])],
		["mpegPs", head([0, 0, 1, 0xba])],
		["mpegVideo", head([0, 0, 1, 0xb3])],
		["mp3", head("ID3")],
		["mp3", head([0xff, 0xfb, 0x90])],
		["flac", head("fLaC")],
		["midi", head("MThd")],
		["amr", head("#!AMR")]
	] as const)("knows %s", (container, bytes) => {
		expect(sniffMedia(bytes)).toBe(container)
	})

	it("knows no container in an image or text", () => {
		expect(sniffMedia(PNG)).toBeUndefined()
		expect(sniffMedia(strToU8("<?xml version"))).toBeUndefined()
		expect(sniffMedia(head("RIFF", [0, 0, 0, 0], "WEBP"))).toBeUndefined()
	})

	it("demotes media whose bytes are no container to its other class, held to that limit", () => {
		expect(confirmMedia(entry("ppt/media/a.mp4", 10), MP4, TYPES)).toEqual({ kind: "media", container: "isoBmff" })
		expect(confirmMedia(entry("ppt/media/a.mp4", 100 * MIB), PNG, TYPES)).toEqual({
			kind: "notMedia",
			class: "other",
			tooLarge: true,
			notice: { kind: "notMediaContainer", part: "ppt/media/a.mp4" }
		})
	})
})

describe("image decode budget", () => {
	it("reads declared pixel sizes from PNG, GIF, BMP, WebP and JPEG headers", () => {
		expect(imageDimensions(PNG)).toEqual({ width: 256, height: 512 })
		expect(imageDimensions(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0, 0x20, 0]))).toEqual({ width: 16, height: 32 })

		const bmp = new Uint8Array(26)

		bmp.set([0x42, 0x4d])
		new DataView(bmp.buffer).setInt32(18, 640, true)
		new DataView(bmp.buffer).setInt32(22, -480, true)
		expect(imageDimensions(bmp)).toEqual({ width: 640, height: 480 })

		const webp = new Uint8Array(30)

		webp.set(strToU8("RIFF"), 0)
		webp.set(strToU8("WEBPVP8X"), 8)
		webp.set([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00], 24)
		expect(imageDimensions(webp)).toEqual({ width: 640, height: 480 })

		const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0])

		expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 })
	})

	it("refuses an image declaring more than 50 M pixels", () => {
		const huge = PNG.slice()

		new DataView(huge.buffer).setUint32(16, 10_000)
		new DataView(huge.buffer).setUint32(20, 5_001)
		expect(imageWithinBudget(huge)).toBe(false)
		new DataView(huge.buffer).setUint32(20, 5_000)
		expect(imageWithinBudget(huge)).toBe(true)
		expect(imageWithinBudget(strToU8("unknown"))).toBe(true)
	})
})
