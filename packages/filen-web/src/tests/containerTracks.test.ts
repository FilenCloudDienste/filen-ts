import { describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES, BlockSource, bytesReadRange, type ReadRange } from "@/lib/media/blockSource"
import { parseMatroskaTracks, readContainerTracks, unplayableTracks, type ContainerTrack } from "@/features/preview/lib/containerTracks"

// Hand-built container headers: just enough of each box/element for the parser, nothing a muxer adds.

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
	const length = parts.reduce((sum, part) => sum + part.length, 0)
	const out = new Uint8Array(length)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function text(value: string): number[] {
	return Array.from(new TextEncoder().encode(value))
}

function uint32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function zeros(length: number): Uint8Array {
	return new Uint8Array(length)
}

// ── MP4 ──

function box(type: string, ...payload: (Uint8Array | readonly number[])[]): Uint8Array {
	const body = concat(...payload)

	return concat(uint32(8 + body.length), text(type), body)
}

function descriptor(tag: number, ...payload: (Uint8Array | readonly number[])[]): Uint8Array {
	const body = concat(...payload)

	return concat([tag, body.length], body)
}

function esds(objectType: number): Uint8Array {
	return box("esds", [0, 0, 0, 0], descriptor(3, [0, 1, 0], descriptor(4, [objectType], zeros(12))))
}

function trak(handler: string, sampleEntry: Uint8Array): Uint8Array {
	return box(
		"trak",
		box("tkhd", zeros(84)),
		box(
			"mdia",
			box("mdhd", zeros(24)),
			box("hdlr", [0, 0, 0, 0], zeros(4), text(handler), zeros(12), [0]),
			box("minf", box("stbl", box("stsd", [0, 0, 0, 0], uint32(1), sampleEntry), box("stts", zeros(8))))
		)
	)
}

function audioEntry(fourcc: string, ...children: Uint8Array[]): Uint8Array {
	return box(fourcc, zeros(28), ...children)
}

function videoEntry(fourcc: string, ...children: Uint8Array[]): Uint8Array {
	return box(fourcc, zeros(78), ...children)
}

function moov(...traks: Uint8Array[]): Uint8Array {
	return box("moov", box("mvhd", zeros(100)), ...traks)
}

const FTYP = box("ftyp", text("isom"), uint32(0x200), text("isomiso2mp41"))

function source(bytes: Uint8Array): BlockSource {
	return new BlockSource(bytes.length, bytesReadRange(bytes))
}

describe("readContainerTracks — MP4/MOV", () => {
	it("reads a moov written before the media data", async () => {
		const file = concat(FTYP, moov(trak("vide", videoEntry("avc1")), trak("soun", audioEntry("ac-3"))), box("mdat", zeros(64)))

		expect(await readContainerTracks(source(file))).toEqual([
			{ kind: "video", codec: "h264" },
			{ kind: "audio", codec: "ac3" }
		])
	})

	it("finds a moov written after the media data, reading only the head and the moov's block", async () => {
		const file = concat(
			FTYP,
			box("mdat", zeros(BLOCK_BYTES * 3)),
			moov(trak("vide", videoEntry("hvc1")), trak("soun", audioEntry("ec-3")))
		)
		const reads: number[] = []
		const read: ReadRange = (start, end) => {
			reads.push(start / BLOCK_BYTES)

			return Promise.resolve(file.subarray(start, end))
		}

		expect(await readContainerTracks(new BlockSource(file.length, read))).toEqual([
			{ kind: "video", codec: "hevc" },
			{ kind: "audio", codec: "eac3" }
		])
		expect(reads).toEqual([0, 3])
	})

	it("names an mp4a/mp4v track by its esds object type", async () => {
		const file = concat(
			FTYP,
			moov(
				trak("soun", audioEntry("mp4a", esds(0x40))),
				trak("soun", audioEntry("mp4a", esds(0x6b))),
				trak("vide", videoEntry("mp4v", esds(0x20)))
			)
		)

		expect(await readContainerTracks(source(file))).toEqual([
			{ kind: "audio", codec: "aac" },
			{ kind: "audio", codec: "mp3" },
			{ kind: "video", codec: "mpeg4" }
		])
	})

	it("reads a QuickTime version 1 sound description's esds from inside its wave box", async () => {
		const entry = box("mp4a", zeros(8), [0, 1], zeros(18), zeros(16), box("wave", box("frma", text("mp4a")), esds(0x40)))

		expect(await readContainerTracks(source(concat(FTYP, moov(trak("soun", entry)))))).toEqual([{ kind: "audio", codec: "aac" }])
	})

	it("keeps an unrecognised codec as null and skips tracks that are neither audio nor video", async () => {
		const file = concat(
			FTYP,
			moov(trak("soun", audioEntry("zzzz")), trak("text", box("tx3g", zeros(8))), trak("soun", audioEntry("mp4a")))
		)

		expect(await readContainerTracks(source(file))).toEqual([
			{ kind: "audio", codec: null },
			{ kind: "audio", codec: null }
		])
	})

	it("gives up on a moov larger than it will download, without downloading it", async () => {
		const moovSize = 8 * 1024 * 1024
		const header = concat(FTYP, uint32(moovSize), text("moov"))
		const read = vi.fn<ReadRange>((start, end) => {
			const block = new Uint8Array(end - start)

			block.set(header.subarray(start, Math.min(end, header.length)))

			return Promise.resolve(block)
		})

		expect(await readContainerTracks(new BlockSource(FTYP.length + moovSize, read))).toBeNull()
		expect(read).toHaveBeenCalledTimes(1)
	})
})

// ── Matroska ──

function ebmlId(id: number): number[] {
	const bytes: number[] = []

	for (let value = id; value > 0; value = Math.floor(value / 256)) {
		bytes.unshift(value & 0xff)
	}

	return bytes
}

function element(id: number, ...payload: (Uint8Array | readonly number[])[]): Uint8Array {
	const body = concat(...payload)

	// A 4-byte size: marker bit 0x10 in the first byte.
	return concat(
		ebmlId(id),
		[0x10 | ((body.length >>> 24) & 0x0f), (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff],
		body
	)
}

const EBML_HEADER = element(0x1a45dfa3, element(0x4282, text("matroska")))

function trackEntry(type: number, codecId: string): Uint8Array {
	return element(0xae, element(0xd7, [1]), element(0x83, [type]), element(0x86, text(codecId)))
}

// A Segment of unknown size (all-ones 8-byte size), as a live writer leaves it.
function segment(...children: Uint8Array[]): Uint8Array {
	return concat(ebmlId(0x18538067), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], ...children)
}

describe("readContainerTracks — Matroska/WebM", () => {
	it("reads Tracks from the file's head", async () => {
		const tracks = element(
			0x1654ae6b,
			trackEntry(1, "V_MPEGH/ISO/HEVC"),
			trackEntry(2, "A_EAC3"),
			trackEntry(17, "S_TEXT/UTF8"),
			trackEntry(2, "A_DTS/EXPRESS")
		)
		const file = concat(EBML_HEADER, segment(element(0x1549a966, zeros(20)), tracks, element(0x1f43b675, zeros(32))))

		expect(await readContainerTracks(source(file))).toEqual([
			{ kind: "video", codec: "hevc" },
			{ kind: "audio", codec: "eac3" },
			{ kind: "audio", codec: "dts" }
		])
	})

	it("follows the SeekHead to Tracks written past the head", async () => {
		const voidElement = element(0xec, zeros(200_000))
		const info = element(0x1549a966, zeros(20))
		// SeekHead with a fixed-width position, so its own size is known before the offset is.
		const seekHeadFor = (position: number): Uint8Array =>
			element(0x114d9b74, element(0x4dbb, element(0x53ab, ebmlId(0x1654ae6b)), element(0x53ac, uint32(position))))
		const tracksOffset = seekHeadFor(0).length + info.length + voidElement.length
		const tracks = element(0x1654ae6b, trackEntry(1, "V_AV1"), trackEntry(2, "A_OPUS"))
		const file = concat(EBML_HEADER, segment(seekHeadFor(tracksOffset), info, voidElement, tracks))

		expect(await readContainerTracks(source(file))).toEqual([
			{ kind: "video", codec: "av1" },
			{ kind: "audio", codec: "opus" }
		])
	})

	it("returns null when nothing points at Tracks before the first Cluster", async () => {
		const file = concat(EBML_HEADER, segment(element(0x1549a966, zeros(20)), element(0x1f43b675, zeros(32))))

		expect(await readContainerTracks(source(file))).toBeNull()
	})

	it("parses a Tracks payload on its own", () => {
		const payload = concat(trackEntry(2, "A_AAC/MPEG4/LC"), trackEntry(2, "A_AC3"), trackEntry(1, "V_UNKNOWN"))

		expect(parseMatroskaTracks(payload)).toEqual([
			{ kind: "audio", codec: "aac" },
			{ kind: "audio", codec: "ac3" },
			{ kind: "video", codec: null }
		])
	})
})

describe("readContainerTracks — anything else", () => {
	it("returns null for a file that is neither container", async () => {
		expect(await readContainerTracks(source(concat(text("ID3"), zeros(200))))).toBeNull()
		expect(await readContainerTracks(source(concat(text("RIFF"), uint32(100), text("AVI "), zeros(100))))).toBeNull()
		expect(await readContainerTracks(source(zeros(4)))).toBeNull()
	})

	it("returns null rather than throwing on a truncated header", async () => {
		const file = concat(FTYP, moov(trak("vide", videoEntry("avc1"))))

		expect(await readContainerTracks(source(file.subarray(0, file.length - 40)))).toBeNull()
		expect(await readContainerTracks(source(concat(EBML_HEADER, ebmlId(0x18538067))))).toBeNull()
	})
})

describe("unplayableTracks", () => {
	const tracks: ContainerTrack[] = [
		{ kind: "video", codec: "hevc" },
		{ kind: "audio", codec: "ac3" },
		{ kind: "audio", codec: "aac" },
		{ kind: "audio", codec: null },
		{ kind: "audio", codec: "ac3" }
	]
	const canPlay = (query: string): boolean => query.includes("mp4a")

	it("lists each codec of the asked kinds that the browser says it cannot decode, once", () => {
		expect(unplayableTracks(tracks, ["audio", "video"], canPlay)).toEqual(["hevc", "ac3"])
		expect(unplayableTracks(tracks, ["audio"], canPlay)).toEqual(["ac3"])
	})

	it("claims nothing when every recognised codec plays", () => {
		expect(unplayableTracks(tracks, ["audio", "video"], () => true)).toEqual([])
	})
})
