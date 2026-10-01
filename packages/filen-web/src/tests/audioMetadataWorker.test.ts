import { describe, expect, it, vi } from "vitest"
import { readAudioMetadata, readAudioMetadataFromBlob, type AudioMetadataDeps } from "@/workers/audioMetadata"
import { BLOCK_BYTES } from "@/lib/media/blockSource"

// Real music-metadata over small synthetic files, with the SDK's range read and thumbnailer faked.

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

function be32(value: number): Uint8Array {
	return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function le32(value: number): Uint8Array {
	return be32(value).reverse()
}

const COVER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

// ID3v2.3 with title/artist/album and a cover, then a run of 128 kbps CBR MPEG frames, zero-padded out to
// `size` bytes.
function mp3(size: number, withCover = true): Uint8Array {
	function frame(id: string, data: Uint8Array): Uint8Array {
		return concat(encoder.encode(id), be32(data.length), new Uint8Array([0, 0]), data)
	}

	function text(value: string): Uint8Array {
		return concat(new Uint8Array([0]), encoder.encode(value))
	}

	const frames = concat(
		frame("TIT2", text("Night Drive")),
		frame("TPE1", text("The Band")),
		frame("TALB", text("Roads")),
		withCover
			? frame("APIC", concat(new Uint8Array([0]), encoder.encode("image/jpeg\0"), new Uint8Array([3, 0]), COVER))
			: new Uint8Array()
	)
	const tagSize = frames.length
	const syncsafe = new Uint8Array([(tagSize >>> 21) & 0x7f, (tagSize >>> 14) & 0x7f, (tagSize >>> 7) & 0x7f, tagSize & 0x7f])
	const header = concat(encoder.encode("ID3"), new Uint8Array([3, 0, 0]), syncsafe)
	const mpegFrame = new Uint8Array(417)

	mpegFrame.set([0xff, 0xfb, 0x90, 0x00])

	const audio = concat(...Array.from({ length: 12 }, () => mpegFrame))
	const out = new Uint8Array(size)

	out.set(concat(header, frames, audio))

	return out
}

// fLaC with STREAMINFO (44.1 kHz, 10 s), a Vorbis comment and a front-cover picture.
function flac(): Uint8Array {
	function block(type: number, last: boolean, data: Uint8Array): Uint8Array {
		return concat(
			new Uint8Array([(last ? 0x80 : 0) | type, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]),
			data
		)
	}

	const packed = (44_100n << 44n) | (1n << 41n) | (15n << 36n) | 441_000n
	const packedBytes = new Uint8Array(8)

	for (let i = 0; i < 8; i++) {
		packedBytes[i] = Number((packed >> BigInt((7 - i) * 8)) & 0xffn)
	}

	const streamInfo = concat(new Uint8Array([0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0]), packedBytes, new Uint8Array(16))
	const comments = ["TITLE=Lake", "ARTIST=Quiet Ones", "ALBUM=Shore"].map(comment => encoder.encode(comment))
	const vorbis = concat(le32(0), le32(comments.length), ...comments.flatMap(comment => [le32(comment.length), comment]))
	const mime = encoder.encode("image/jpeg")
	const picture = concat(be32(3), be32(mime.length), mime, be32(0), be32(1), be32(1), be32(24), be32(0), be32(COVER.length), COVER)

	return concat(encoder.encode("fLaC"), block(0, false, streamInfo), block(4, false, vorbis), block(6, true, picture), new Uint8Array(64))
}

function readerOver(bytes: Uint8Array): ReturnType<typeof vi.fn<(start: number, end: number) => Promise<Uint8Array>>> {
	return vi.fn<(start: number, end: number) => Promise<Uint8Array>>((start, end) => Promise.resolve(bytes.slice(start, end)))
}

function makeDeps(signal: AbortSignal = new AbortController().signal): AudioMetadataDeps & {
	makeThumbnail: ReturnType<typeof vi.fn<(cover: Uint8Array) => Promise<Uint8Array | null>>>
	storeThumbnail: ReturnType<typeof vi.fn<(bytes: Uint8Array) => Promise<void>>>
} {
	return {
		signal,
		makeThumbnail: vi.fn<(cover: Uint8Array) => Promise<Uint8Array | null>>(() => Promise.resolve(new Uint8Array([7, 7, 7]))),
		storeThumbnail: vi.fn<(bytes: Uint8Array) => Promise<void>>(() => Promise.resolve())
	}
}

describe("readAudioMetadata (ranged)", () => {
	it("reads ID3 tags and the cover from the head, and only probes the tail, never the body", async () => {
		const bytes = mp3(BLOCK_BYTES * 3)
		const reader = readerOver(bytes)
		const deps = makeDeps()

		const result = await readAudioMetadata(bytes.length, "audio/mpeg", reader, deps)

		expect(result).toMatchObject({ type: "parsed", tags: { title: "Night Drive", artist: "The Band", album: "Roads" } })
		expect(result.type === "parsed" ? result.thumbnail : null).toEqual(new Uint8Array([7, 7, 7]))
		expect(deps.makeThumbnail).toHaveBeenCalledWith(COVER)
		expect(deps.storeThumbnail).toHaveBeenCalledWith(new Uint8Array([7, 7, 7]))
		expect(reader.mock.calls.map(([start]) => start / BLOCK_BYTES).sort()).toEqual([0, 2])
	})

	it("reads FLAC tags, cover and duration", async () => {
		const bytes = flac()
		const deps = makeDeps()

		const result = await readAudioMetadata(bytes.length, "audio/flac", readerOver(bytes), deps)

		expect(result).toMatchObject({ type: "parsed", tags: { title: "Lake", artist: "Quiet Ones", album: "Shore", durationSec: 10 } })
		expect(deps.makeThumbnail).toHaveBeenCalledWith(COVER)
	})

	it("returns no thumbnail for a file without a cover, or one the thumbnailer refuses", async () => {
		const bare = mp3(8192, false)
		const bareDeps = makeDeps()

		expect(await readAudioMetadata(bare.length, "audio/mpeg", readerOver(bare), bareDeps)).toMatchObject({
			type: "parsed",
			thumbnail: null
		})
		expect(bareDeps.makeThumbnail).not.toHaveBeenCalled()

		const covered = mp3(8192)
		const refusing = makeDeps()

		refusing.makeThumbnail.mockResolvedValue(null)

		expect(await readAudioMetadata(covered.length, "audio/mpeg", readerOver(covered), refusing)).toMatchObject({
			type: "parsed",
			thumbnail: null
		})
		expect(refusing.storeThumbnail).not.toHaveBeenCalled()
	})

	it("settles unparseable for bytes no parser recognizes", async () => {
		const garbage = encoder.encode("definitely not audio ".repeat(400))

		expect(await readAudioMetadata(garbage.length, "", readerOver(garbage), makeDeps())).toEqual({ type: "unparseable" })
	})

	it("reports readFailed, not unparseable, when the bytes did not arrive", async () => {
		const reader = vi.fn(() => Promise.reject(new Error("network down")))

		expect(await readAudioMetadata(BLOCK_BYTES * 2, "audio/mpeg", reader, makeDeps())).toEqual({ type: "readFailed" })
	})

	it("rejects on abort and stores nothing", async () => {
		const controller = new AbortController()
		const deps = makeDeps(controller.signal)
		const reader = vi.fn(() => {
			controller.abort()

			return Promise.reject(new Error("cancelled"))
		})

		await expect(readAudioMetadata(BLOCK_BYTES, "audio/mpeg", reader, deps)).rejects.toBeDefined()
		expect(deps.storeThumbnail).not.toHaveBeenCalled()
	})
})

describe("readAudioMetadataFromBlob", () => {
	it("parses bytes already in memory, typed or not", async () => {
		const deps = makeDeps()

		expect(await readAudioMetadataFromBlob(new Blob([flac() as Uint8Array<ArrayBuffer>], { type: "audio/flac" }), deps)).toMatchObject({
			type: "parsed",
			tags: { title: "Lake" }
		})
		expect(await readAudioMetadataFromBlob(new Blob([mp3(8192) as Uint8Array<ArrayBuffer>]), deps)).toMatchObject({
			type: "parsed",
			tags: { title: "Night Drive" }
		})
	})

	it("settles unparseable for a blob no parser recognizes", async () => {
		expect(await readAudioMetadataFromBlob(new Blob(["plain text, not audio"]), makeDeps())).toEqual({ type: "unparseable" })
	})
})
