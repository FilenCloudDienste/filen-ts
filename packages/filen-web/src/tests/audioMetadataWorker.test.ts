import { describe, expect, it, vi } from "vitest"
import { readAudioMetadata, type AudioMetadataDeps } from "@/workers/audioMetadata"
import { BLOCK_BYTES } from "@filen/shared/videos"

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
function mp3(size: number, withCover = true, txxx: [string, string][] = []): Uint8Array {
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
		...txxx.map(([description, value]) => frame("TXXX", text(`${description}\0${value}`))),
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
	const comments = ["TITLE=Lake", "ARTIST=Quiet Ones", "ALBUM=Shore", "REPLAYGAIN_TRACK_GAIN=-6.00 dB"].map(comment =>
		encoder.encode(comment)
	)
	const vorbis = concat(le32(0), le32(comments.length), ...comments.flatMap(comment => [le32(comment.length), comment]))
	const mime = encoder.encode("image/jpeg")
	const picture = concat(be32(3), be32(mime.length), mime, be32(0), be32(1), be32(1), be32(24), be32(0), be32(COVER.length), COVER)

	return concat(encoder.encode("fLaC"), block(0, false, streamInfo), block(4, false, vorbis), block(6, true, picture), new Uint8Array(64))
}

// One Ogg page of whole packets (CRC zero: music-metadata does not check it).
function oggPage(serial: number, flags: number, granule: number, packets: Uint8Array[]): Uint8Array {
	const lacing = packets.flatMap(packet => [...new Array<number>(Math.floor(packet.length / 255)).fill(255), packet.length % 255])

	return concat(
		encoder.encode("OggS"),
		new Uint8Array([0, flags]),
		le32(granule),
		le32(0),
		le32(serial),
		le32(0),
		le32(0),
		new Uint8Array([lacing.length, ...lacing]),
		...packets
	)
}

// Ogg Vorbis, and beside it a Theora stream of `pictures` picture packets (320x240, 25 fps).
function oggWithTheora(pictures: number, size: number): Uint8Array {
	const theora = concat(
		new Uint8Array([0x80]),
		encoder.encode("theora"),
		new Uint8Array([3, 2, 1, 0, 20, 0, 15, 0, 1, 64, 0, 0, 240, 0, 0, 0, 0, 0, 25, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0xc0])
	)
	const vorbis = concat(
		new Uint8Array([1]),
		encoder.encode("vorbis"),
		le32(0),
		new Uint8Array([2]),
		le32(44100),
		le32(0),
		le32(0),
		le32(0),
		new Uint8Array([0xb8, 1])
	)
	const vendor = encoder.encode("test")
	const comment = concat(new Uint8Array([3]), encoder.encode("vorbis"), le32(vendor.length), vendor, le32(0), new Uint8Array([1]))
	const setup = concat(new Uint8Array([5]), encoder.encode("vorbis"), new Uint8Array([0]))
	const out = new Uint8Array(size)

	out.set(
		concat(
			oggPage(1, 2, 0, [theora]),
			oggPage(2, 2, 0, [vorbis]),
			oggPage(1, 0, 0, [
				concat(new Uint8Array([0x81]), encoder.encode("theora")),
				concat(new Uint8Array([0x82]), encoder.encode("theora"))
			]),
			oggPage(2, 0, 0, [comment, setup]),
			oggPage(
				1,
				0,
				pictures << 6,
				Array.from({ length: pictures }, () => new Uint8Array([0, 1, 2]))
			),
			oggPage(2, 4, 44100, [new Uint8Array([0, 9])])
		)
	)

	return out
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

		expect(result).toMatchObject({
			type: "parsed",
			tags: { title: "Lake", artist: "Quiet Ones", album: "Shore", durationSec: 10 },
			gain: { trackDb: -6, trackPeak: null }
		})
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

	it('reads ReplayGain from the raw TXXX frames, "+3.2dB" without a space included', async () => {
		const bytes = mp3(8192, false, [
			["REPLAYGAIN_TRACK_GAIN", "+3.2dB"],
			["replaygain_track_peak", "0.5"],
			["REPLAYGAIN_ALBUM_GAIN", "-7.10 dB"]
		])

		expect(await readAudioMetadata(bytes.length, "audio/mpeg", readerOver(bytes), makeDeps())).toMatchObject({
			type: "parsed",
			gain: { trackDb: 3.2, trackPeak: 0.5, albumDb: -7.1, albumPeak: null }
		})
	})

	it("reads an untagged file's gain as all nulls", async () => {
		const bytes = mp3(8192, false)

		expect(await readAudioMetadata(bytes.length, "audio/mpeg", readerOver(bytes), makeDeps())).toMatchObject({
			gain: { trackDb: null, trackPeak: null, albumDb: null, albumPeak: null }
		})
	})

	it("reads the gain alone with skipCover: no cover is thumbnailed or stored", async () => {
		const bytes = mp3(8192, true, [["REPLAYGAIN_TRACK_GAIN", "-4 dB"]])
		const deps = { ...makeDeps(), skipCover: true }

		expect(await readAudioMetadata(bytes.length, "audio/mpeg", readerOver(bytes), deps)).toMatchObject({
			type: "parsed",
			tags: { title: "Night Drive" },
			gain: { trackDb: -4 },
			thumbnail: null
		})
		expect(deps.makeThumbnail).not.toHaveBeenCalled()
		expect(deps.storeThumbnail).not.toHaveBeenCalled()
	})

	it("reports a real Ogg picture stream from the block it already read, and no cover frame as one", async () => {
		const bytes = oggWithTheora(3, BLOCK_BYTES * 3)
		const reader = readerOver(bytes)
		const result = await readAudioMetadata(bytes.length, "audio/ogg", reader, makeDeps())

		expect(result).toMatchObject({ video: { codec: "theora", codecString: "theora", width: 320, height: 240 } })
		expect(reader.mock.calls.every(([start]) => start !== BLOCK_BYTES)).toBe(true)

		const cover = oggWithTheora(1, 4096)

		expect(await readAudioMetadata(cover.length, "audio/ogg", readerOver(cover), makeDeps())).not.toHaveProperty("video")
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
