import { deflateSync } from "node:zlib"
import { describe, expect, it, vi } from "vitest"
import {
	BLOCK_BYTES,
	BlockSource,
	OutOfFileReadError,
	type ReadRange,
	inflateCapped,
	parseElementHeader,
	initialBlockReads,
	probeVideo,
	walkContainer,
	type ProbeTier,
	type VideoProbe
} from "@filen/shared/videos"
import {
	FTYP,
	audioEntry,
	box,
	concat,
	ebmlHeader,
	ebmlId,
	element,
	esds,
	f64,
	fullBox,
	hdlr,
	largeBox,
	mdhd,
	mvhd,
	segment,
	stringElement,
	text,
	tkhd,
	trak,
	u16,
	u32,
	u64,
	uintElement,
	unknownSize,
	videoEntry,
	zeros
} from "@/tests/support/containerBytes"

interface Probed {
	record: VideoProbe | null
	reads: number[]
}

async function probe(bytes: Uint8Array, tier: ProbeTier): Promise<Probed> {
	const reads: number[] = []
	const readRange: ReadRange = (start, end) => {
		reads.push(start / BLOCK_BYTES)

		return Promise.resolve(bytes.slice(start, end))
	}
	const record = await probeVideo(new BlockSource(bytes.length, readRange, { maxBlockReads: initialBlockReads(tier) }), tier)

	return { record, reads }
}

// x264 High@L3.1, as in the fixtures.
const AVCC = box(
	"avcC",
	Array.from(Buffer.from("0164001fffe1001a6764001facd9405005bb011000000300100000030300f183196001000468ef89cbfdf8f800", "hex"))
)
const AAC_LC_48K_STEREO = [0x11, 0x90]

// ── MP4 ──

function avcTrak(id: number, ...extra: Uint8Array[]): Uint8Array {
	return trak(tkhd({ id }), [mdhd({}), hdlr("vide")], videoEntry("avc1", {}, AVCC, ...extra))
}

function aacTrak(id: number, language = "und", ...mdiaExtra: Uint8Array[]): Uint8Array {
	return trak(
		tkhd({ id, enabled: id === 2 }),
		[mdhd({ language }), hdlr("soun"), ...mdiaExtra],
		audioEntry("mp4a", {}, esds(0x40, AAC_LC_48K_STEREO))
	)
}

function chpl(chapters: [number, string][]): Uint8Array {
	return fullBox(
		"chpl",
		1,
		0,
		zeros(4),
		[chapters.length],
		...chapters.map(([seconds, title]) => concat(u64(seconds * 1e7), [text(title).length], text(title)))
	)
}

function covr(type: number, image: number[]): Uint8Array {
	return box("covr", box("data", u32(type), u32(0), image))
}

describe("probeVideo — MP4", () => {
	it("reads everything the full tier records", async () => {
		const colr = box("colr", text("nclx"), u16(9), u16(16), u16(9), [0])
		const pasp = box("pasp", u32(4), u32(3))
		const dvcC = box("dvcC", [1, 0, (8 << 1) | 0, (6 << 3) | 0b101, 1 << 4], zeros(19))
		const video = trak(
			tkhd({ id: 1, matrix: [0, 1, -1, 0] }),
			[mdhd({}), hdlr("vide")],
			videoEntry(
				"hvc1",
				{ width: 3840, height: 2160 },
				box("hvcC", [1, 0x22, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 153], zeros(4), [0xfa], zeros(5)),
				colr,
				pasp,
				dvcC
			)
		)
		const commentary = aacTrak(3, "eng", fullBox("elng", 0, 0, text("en-GB"), [0]))
		const named = box(
			"trak",
			tkhd({ id: 2 }),
			box(
				"mdia",
				mdhd({ language: "deu" }),
				hdlr("soun"),
				box(
					"minf",
					box("stbl", box("stsd", zeros(4), u32(1), audioEntry("ac-3", { channels: 2 }, box("dac3", [0x10, 0x3d, 0xc0]))))
				)
			),
			box("udta", box("name", text("Surround")))
		)
		const subtitle = trak(tkhd({ id: 4 }), [mdhd({ language: "fra" }), hdlr("sbtl")], box("tx3g", zeros(30)))
		const udta = box(
			"udta",
			chpl([
				[0, "Intro"],
				[95.5, "Scène 2"]
			]),
			fullBox("meta", 0, 0, hdlr("mdir"), box("ilst", box("desc", zeros(8)), covr(14, [0x89, 0x50, 0x4e, 0x47, 1, 2, 3])))
		)
		const file = concat(
			FTYP,
			box("moov", mvhd({ timescale: 600, duration: 600 * 125 }), video, named, commentary, subtitle, udta),
			box("mdat", zeros(64))
		)
		const coverAt = file.length - 64 - 8 - 7

		expect((await probe(file, "full")).record).toEqual({
			v: 1,
			container: "mp4",
			durationSec: 125,
			index: "moov",
			video: {
				codec: "hevc",
				fourcc: "hvc1",
				codecString: "hvc1.2.4.H153.90",
				w: 3840,
				h: 2160,
				par: 1.3333,
				rotation: 90,
				bitDepth: 10,
				transfer: "pq",
				dv: { profile: 8, compat: 1 }
			},
			audio: [
				{
					id: 2,
					codec: "ac3",
					codecString: "ac-3",
					ch: 6,
					rate: 48000,
					lang: "deu",
					name: "Surround",
					def: true,
					forced: false,
					commentary: false
				},
				{
					id: 3,
					codec: "aac",
					codecString: "mp4a.40.2",
					ch: 2,
					rate: 48000,
					lang: "en-GB",
					name: null,
					def: false,
					forced: false,
					commentary: false
				}
			],
			subs: [{ id: 4, codecId: "tx3g", lang: "fra", name: null, def: true, forced: false, hi: false }],
			chapters: [
				{ t: 0, title: "Intro" },
				{ t: 95.5, title: "Scène 2" }
			],
			cover: { offset: coverAt, size: 7, mime: "image/png" },
			coverLand: null,
			partial: false
		})
	})

	it("leaves names and chapters to the full tier, and gives the cover tier the card's fields plus the cover", async () => {
		const file = concat(
			FTYP,
			box(
				"moov",
				mvhd({ duration: 5000 }),
				avcTrak(1),
				box("udta", chpl([[0, "A"]]), fullBox("meta", 0, 0, box("ilst", covr(13, [0xff, 0xd8]))))
			)
		)
		const card = (await probe(file, "card")).record
		const cover = (await probe(file, "cover")).record

		expect(card?.chapters).toEqual([])
		expect(card?.cover).toBeNull()
		expect(card?.video?.codecString).toBe("avc1.64001f")
		expect(cover).toMatchObject({ video: card?.video, durationSec: 5, chapters: [], cover: { mime: "image/jpeg", size: 2 } })
	})

	it("drops a QuickTime chapter text track from the subtitles", async () => {
		const video = trak(tkhd({ id: 1 }), [mdhd({}), hdlr("vide")], videoEntry("avc1", {}, AVCC), box("tref", box("chap", u32(2))))
		const chapters = trak(tkhd({ id: 2, enabled: false }), [mdhd({}), hdlr("text")], box("text", zeros(40)))

		expect((await probe(concat(FTYP, box("moov", mvhd({}), video, chapters)), "full")).record?.subs).toEqual([])
	})

	it("walks past a 64-bit mdat to a tail moov, reading only the blocks holding headers", async () => {
		const file = concat(FTYP, largeBox("mdat", zeros(BLOCK_BYTES * 2)), box("moov", mvhd({ duration: 1000 }), avcTrak(1)))
		const { record, reads } = await probe(file, "card")

		expect(record?.video?.w).toBe(1280)
		expect(reads).toEqual([0, 2])
	})

	it("returns what the card found, flagged partial, when the moov's headers sit in more blocks than it may read", async () => {
		// Each track's sample tables fill a block, so every trak header is a block of its own.
		const padded = (inner: Uint8Array): Uint8Array => box("trak", inner.subarray(8), box("free", zeros(BLOCK_BYTES)))
		const file = concat(
			FTYP,
			box("mdat", zeros(BLOCK_BYTES)),
			box(
				"moov",
				mvhd({ duration: 1000 }),
				padded(avcTrak(1)),
				padded(aacTrak(2)),
				padded(aacTrak(3)),
				box("udta", box("desc", zeros(8)))
			)
		)
		const { record, reads } = await probe(file, "card")

		expect(reads.length).toBe(4)
		expect(record?.partial).toBe(true)
		expect(record?.video?.codec).toBe("h264")
		expect(record?.audio.map(track => track.id)).toEqual([2, 3])

		const full = await probe(file, "full")

		expect(full.record?.partial).toBe(false)
		expect(full.record?.audio.length).toBe(2)
		expect(full.reads.length).toBeLessThanOrEqual(Math.ceil(file.length / BLOCK_BYTES) + 2)
	})

	it("stops the card at the last track mvhd counts when reading on would cost a download", async () => {
		const padded = (inner: Uint8Array): Uint8Array => box("trak", inner.subarray(8), box("free", zeros(BLOCK_BYTES)))
		const file = concat(
			FTYP,
			box(
				"moov",
				mvhd({ duration: 1000, nextTrackId: 3 }),
				padded(avcTrak(1)),
				padded(aacTrak(2)),
				box("udta", box("desc", zeros(8)))
			)
		)
		const { record, reads } = await probe(file, "card")

		expect(record?.partial).toBe(false)
		expect(record?.index).toBeNull()
		expect(reads).toEqual([0, 1])
	})

	it("finds a fragmented file's mfra and its duration in mehd", async () => {
		const mvex = box("mvex", fullBox("mehd", 0, 0, u32(90_000)), fullBox("trex", 0, 0, zeros(20)))
		const tfra = fullBox("tfra", 0, 0, zeros(12))
		const mfra = box("mfra", tfra, fullBox("mfro", 0, 0, u32(8 + tfra.length + 16)))
		const file = concat(
			FTYP,
			box("moov", mvhd({ timescale: 1000, duration: 0 }), avcTrak(1), mvex),
			box("moof", zeros(16)),
			box("mdat", zeros(16)),
			mfra
		)

		expect((await probe(file, "full")).record).toMatchObject({ durationSec: 90, index: "mfra" })
		expect((await probe(file, "card")).record?.index).toBeNull()
	})

	it("allows a size-0 box only at the top level", async () => {
		const sizeZeroMdat = concat(u32(0), text("mdat"), zeros(32))
		const tailOk = concat(FTYP, box("moov", mvhd({ duration: 1000 }), avcTrak(1)), sizeZeroMdat)

		expect((await probe(tailOk, "card")).record?.partial).toBe(false)

		const nested = concat(FTYP, box("moov", mvhd({ duration: 1000 }), concat(u32(0), text("trak"), zeros(16))))

		expect((await probe(nested, "card")).record).toMatchObject({ partial: true, video: null })
	})

	it("rejects a child that reaches past its parent, keeping the tracks before it", async () => {
		const broken = concat(u32(4096), text("trak"), zeros(16))
		const file = concat(FTYP, box("moov", mvhd({ duration: 1000 }), avcTrak(1), broken))

		expect((await probe(file, "full")).record).toMatchObject({ partial: true, video: { codec: "h264" } })
	})

	it("reads a QuickTime version 2 sound description and a file without ftyp as MOV", async () => {
		const entry = box(
			"lpcm",
			zeros(6),
			u16(1),
			u16(2),
			zeros(6),
			u16(3),
			u16(16),
			u16(0xfffe),
			u16(0),
			u32(0x10000),
			u32(72),
			f64(44100),
			u32(6),
			zeros(20)
		)
		const file = concat(box("wide", zeros(0)), box("moov", mvhd({}), trak(tkhd({ id: 1 }), [mdhd({}), hdlr("soun")], entry)))

		expect((await probe(file, "card")).record).toMatchObject({ container: "mov", audio: [{ codec: null, ch: 6, rate: 44100 }] })
	})

	it("returns null for anything that is no ISO BMFF or EBML file, after one block", async () => {
		for (const file of [concat(text("RIFF"), u32(100), text("AVI "), zeros(100)), concat(text("ID3"), zeros(200)), zeros(4)]) {
			const { record, reads } = await probe(file, "full")

			expect(record).toBeNull()
			expect(reads.length).toBeLessThanOrEqual(1)
		}
	})
})

// ── Matroska ──

const INFO = element(0x1549a966, uintElement(0x2ad7b1, 1_000_000), element(0x4489, f64(30_037)))
const AVC_PRIVATE = AVCC.subarray(8)

function trackEntry(number: number, type: number, codecId: string, ...fields: Uint8Array[]): Uint8Array {
	return element(0xae, uintElement(0xd7, number), uintElement(0x83, type), stringElement(0x86, codecId), ...fields)
}

function tracks(...entries: Uint8Array[]): Uint8Array {
	return element(0x1654ae6b, ...entries)
}

function seekHead(entries: [number, number][]): Uint8Array {
	return element(
		0x114d9b74,
		...entries.map(([id, position]) => element(0x4dbb, element(0x53ab, ebmlId(id)), element(0x53ac, u32(position))))
	)
}

function atom(start: number, title: string, ...fields: Uint8Array[]): Uint8Array {
	return element(0xb6, uintElement(0x91, start * 1e9), ...fields, element(0x80, stringElement(0x85, title)))
}

function mkv(...children: Uint8Array[]): Uint8Array {
	return concat(ebmlHeader(), segment(...children))
}

const VIDEO_TRACK = trackEntry(
	1,
	1,
	"V_MPEG4/ISO/AVC",
	element(0x63a2, AVC_PRIVATE),
	element(0xe0, uintElement(0xb0, 1920), uintElement(0xba, 1080))
)

describe("probeVideo — 3GPP", () => {
	it("names H.263 pictures and AMR sound, which no browser plays as they are", async () => {
		const file = concat(
			FTYP,
			box(
				"moov",
				mvhd({ timescale: 1000, duration: 4000 }),
				trak(tkhd({ id: 1 }), [mdhd({}), hdlr("vide")], videoEntry("s263", { width: 176, height: 144 })),
				trak(tkhd({ id: 2 }), [mdhd({}), hdlr("soun")], audioEntry("samr", { channels: 1, rate: 8000 })),
				trak(tkhd({ id: 3 }), [mdhd({}), hdlr("soun")], audioEntry("sawb", { channels: 1, rate: 16000 }))
			)
		)
		const record = (await probe(file, "card")).record

		expect(record?.video).toMatchObject({ codec: "h263", fourcc: "s263", codecString: null, w: 176, h: 144 })
		expect(record?.audio.map(({ codec, codecString, rate }) => ({ codec, codecString, rate }))).toEqual([
			{ codec: "amr", codecString: null, rate: 8000 },
			{ codec: "amrwb", codecString: null, rate: 16000 }
		])
	})
})

describe("probeVideo — Matroska", () => {
	it("reads track flags, BCP 47 languages first, and Matroska's English default", async () => {
		const file = mkv(
			INFO,
			tracks(
				VIDEO_TRACK,
				trackEntry(
					2,
					2,
					"A_AAC",
					element(0x63a2, AAC_LC_48K_STEREO),
					stringElement(0x22b59c, "ger"),
					stringElement(0x22b59d, "de-AT"),
					uintElement(0x88, 0),
					element(0xe1, element(0xb5, f64(48000)), uintElement(0x9f, 2))
				),
				trackEntry(3, 2, "A_OPUS", uintElement(0x55af, 1), stringElement(0x536e, "Director"), element(0xe1, uintElement(0x9f, 6))),
				trackEntry(4, 2, "A_FLAC", uintElement(0xb9, 0)),
				trackEntry(5, 17, "S_TEXT/UTF8", stringElement(0x22b59c, "und"), uintElement(0x55aa, 1), uintElement(0x55ab, 1))
			),
			element(0x1f43b675, zeros(16))
		)
		const record = (await probe(file, "card")).record

		expect(record?.durationSec).toBe(30.037)
		expect(record?.audio).toEqual([
			{
				id: 2,
				codec: "aac",
				codecString: "mp4a.40.2",
				ch: 2,
				rate: 48000,
				lang: "de-AT",
				name: null,
				def: false,
				forced: false,
				commentary: false
			},
			{
				id: 3,
				codec: "opus",
				codecString: "opus",
				ch: 6,
				rate: 48000,
				lang: "eng",
				name: "Director",
				def: true,
				forced: false,
				commentary: true
			}
		])
		expect(record?.subs).toEqual([{ id: 5, codecId: "S_TEXT/UTF8", lang: null, name: null, def: true, forced: true, hi: true }])
	})

	it("reads colour, bit depth, display aspect, rotation and a Dolby Vision mapping", async () => {
		const colour = element(
			0x55b0,
			uintElement(0x55b2, 10),
			uintElement(0x55ba, 18),
			uintElement(0x55bb, 9),
			uintElement(0x55b1, 9),
			uintElement(0x55b9, 1)
		)
		const video = element(
			0xe0,
			uintElement(0xb0, 1440),
			uintElement(0xba, 1080),
			uintElement(0x54b0, 1920),
			uintElement(0x54ba, 1080),
			colour,
			element(0x7670, element(0x7675, f64(90)))
		)
		const mapping = element(0x41e4, uintElement(0x41e7, 0x64766343), element(0x41ed, [1, 0, 10 << 1, 6 << 3, 4 << 4], zeros(19)))
		const av1C = [0x81, 0x08, 0x4c, 0x00]
		const file = mkv(INFO, tracks(trackEntry(1, 1, "V_AV1", element(0x63a2, av1C), video, mapping)))

		expect((await probe(file, "card")).record?.video).toEqual({
			codec: "av1",
			fourcc: "av01",
			codecString: "av01.0.08M.10.0.110.09.18.09.0",
			w: 1440,
			h: 1080,
			par: 1.3333,
			rotation: 270,
			bitDepth: 10,
			transfer: "hlg",
			dv: { profile: 10, compat: 4 }
		})
	})

	it("undoes zlib and header-stripping compression of CodecPrivate, capping the inflated size", async () => {
		const encoding = (algorithm: number, settings?: number[]): Uint8Array =>
			element(
				0x6d80,
				element(
					0x6240,
					uintElement(0x5032, 2),
					element(0x5034, uintElement(0x4254, algorithm), ...(settings === undefined ? [] : [element(0x4255, settings)]))
				)
			)
		const zlib = trackEntry(1, 2, "A_AAC", element(0x63a2, deflateSync(Buffer.from(AAC_LC_48K_STEREO))), encoding(0))
		const stripped = trackEntry(2, 2, "A_AAC", element(0x63a2, [0x90]), encoding(3, [0x11]))
		const bomb = trackEntry(3, 2, "A_AAC", element(0x63a2, deflateSync(Buffer.alloc(2 * 1024 * 1024))), encoding(0))
		const lzo = trackEntry(4, 2, "A_AAC", element(0x63a2, AAC_LC_48K_STEREO), encoding(2))
		const record = (await probe(mkv(INFO, tracks(zlib, stripped, bomb, lzo)), "card")).record

		expect(record?.audio.map(track => track.codecString)).toEqual(["mp4a.40.2", "mp4a.40.2", null, null])
	})

	it("reads the default edition's visible, enabled, local chapters in time order", async () => {
		const chapters = element(
			0x1043a770,
			element(0x45b9, uintElement(0x45bd, 1), atom(0, "Hidden edition")),
			element(
				0x45b9,
				uintElement(0x45db, 1),
				atom(60, "Second", uintElement(0x4588, 3)),
				atom(0, "First", uintElement(0x92, 60e9), uintElement(0x4588, 1)),
				atom(10, "Hidden", uintElement(0x98, 1)),
				atom(20, "Disabled", uintElement(0x4598, 0)),
				atom(30, "Linked", element(0x6e67, zeros(16))),
				atom(40, "Bad skip type", uintElement(0x4588, 9))
			)
		)
		const file = mkv(INFO, tracks(VIDEO_TRACK), chapters)

		expect((await probe(file, "full")).record?.chapters).toEqual([
			{ t: 0, end: 60, title: "First", skipType: 1 },
			{ t: 40, title: "Bad skip type" },
			{ t: 60, title: "Second", skipType: 3 }
		])
	})

	it("ends a chapter without its own end at the next atom, shown or not, and at a shown one past the cap", async () => {
		const shown = element(
			0x1043a770,
			element(
				0x45b9,
				atom(0, "Opening"),
				atom(90, "Hidden", uintElement(0x98, 1)),
				atom(120, "Recap"),
				atom(150, "Disabled", uintElement(0x4598, 0)),
				atom(200, "Linked", element(0x6e67, zeros(16))),
				atom(300, "Part 1")
			)
		)

		expect((await probe(mkv(INFO, tracks(VIDEO_TRACK), shown), "full")).record?.chapters).toEqual([
			{ t: 0, end: 90, title: "Opening" },
			{ t: 120, end: 150, title: "Recap" },
			{ t: 300, title: "Part 1" }
		])

		const many = Array.from({ length: 66 }, (_, index) => atom(index * 10, `Chapter ${String(index)}`))
		const capped = (await probe(mkv(INFO, tracks(VIDEO_TRACK), element(0x1043a770, element(0x45b9, ...many))), "full")).record?.chapters

		expect(capped?.[62]).toEqual({ t: 620, title: "Chapter 62" })
		expect(capped?.[63]).toEqual({ t: 630, end: 640, title: "Chapter 63" })
	})

	it("follows the SeekHead past large front attachments to the chapters, and finds the cover a hop away", async () => {
		const font = element(
			0x61a7,
			stringElement(0x466e, "font.ttf"),
			stringElement(0x4660, "font/ttf"),
			element(0x465c, zeros(BLOCK_BYTES + 100))
		)
		const png = [0x89, 0x50, 0x4e, 0x47]
		const attachments = element(0x1941a469, font, element(0x61a7, stringElement(0x466e, "cover.png"), element(0x465c, png)))
		const chapters = element(0x1043a770, element(0x45b9, atom(0, "Only")))
		const trackList = tracks(VIDEO_TRACK)
		// Fixed-width positions, so the SeekHead's own size is known before the offsets are.
		const headSize = seekHead([
			[0x1941a469, 0],
			[0x1043a770, 0]
		]).length
		const attachmentsAt = headSize + INFO.length + trackList.length
		const head = seekHead([
			[0x1941a469, attachmentsAt],
			[0x1043a770, attachmentsAt + attachments.length]
		])
		const file = mkv(head, INFO, trackList, attachments, chapters, element(0x1f43b675, zeros(16)))
		const { record, reads } = await probe(file, "full")

		expect(record?.chapters).toEqual([{ t: 0, title: "Only" }])
		expect(record?.cover).toEqual({ offset: Buffer.from(file).indexOf(Buffer.from(png)), size: 4, mime: "image/png" })
		expect(reads).toEqual([0, 1])
		expect((await probe(file, "card")).reads).toEqual([0])
	})

	it("reports Cues through the SeekHead without reading them, and none when the SeekHead lists none", async () => {
		const withCues = mkv(seekHead([[0x1c53bb6b, 0x7fff]]), INFO, tracks(VIDEO_TRACK), element(0x1f43b675, zeros(0x8000)))
		const without = mkv(seekHead([[0x1549a966, 0]]), INFO, tracks(VIDEO_TRACK), element(0x1f43b675, zeros(16)))

		expect((await probe(withCues, "full")).record?.index).toBe("cues")
		expect((await probe(without, "full")).record?.index).toBe("none")
	})

	it("refuses elements of unknown size other than Segment and Cluster, and oversized Tracks, without reading them", async () => {
		const unknownTracks = mkv(INFO, unknownSize(0x1654ae6b, VIDEO_TRACK))
		const huge = concat(ebmlHeader(), segment(INFO, concat(ebmlId(0x1654ae6b), [0x01, 0, 0, 0, 0, 0x20, 0, 0])))

		expect((await probe(unknownTracks, "card")).record).toMatchObject({ partial: true, video: null })
		expect((await probe(huge, "card")).record).toMatchObject({ partial: true, video: null })
	})

	it("resyncs past garbage between top-level elements inside the block it already has", async () => {
		const file = mkv(INFO, new Uint8Array([0x00, 0x00, 0xff, 0x7f]), tracks(VIDEO_TRACK))

		expect((await probe(file, "card")).record).toMatchObject({ partial: true, video: { codec: "h264", w: 1920 } })
	})

	it("returns null for an EBML document that is not Matroska", async () => {
		expect((await probe(concat(ebmlHeader("foo"), segment(INFO)), "card")).record).toBeNull()
	})

	it("finds the landscape cover beside the cover, in either order, and leaves both to the cover and full tiers", async () => {
		const png = [0x89, 0x50, 0x4e, 0x47]
		const jpeg = [0xff, 0xd8, 0xff]
		const file = mkv(
			INFO,
			tracks(VIDEO_TRACK),
			element(
				0x1941a469,
				element(0x61a7, stringElement(0x466e, "Cover_Land.JPG"), element(0x465c, jpeg)),
				element(0x61a7, stringElement(0x466e, "small_cover.png"), element(0x465c, [1, 2])),
				element(0x61a7, stringElement(0x466e, "cover.png"), stringElement(0x4660, "image/png"), element(0x465c, png)),
				element(0x61a7, stringElement(0x466e, "cover_land.png"), element(0x465c, [3, 4]))
			)
		)
		const at = (bytes: number[]) => Buffer.from(file).indexOf(Buffer.from(bytes))

		for (const tier of ["cover", "full"] as const) {
			expect((await probe(file, tier)).record).toMatchObject({
				cover: { offset: at(png), size: 4, mime: "image/png" },
				coverLand: { offset: at(jpeg), size: 3, mime: "image/jpeg" },
				partial: false
			})
		}

		expect((await probe(file, "card")).record).toMatchObject({ cover: null, coverLand: null })
	})

	it("never takes a cover MIME type from an inherited object key of the file extension", async () => {
		const file = mkv(
			INFO,
			tracks(VIDEO_TRACK),
			element(
				0x1941a469,
				element(0x61a7, stringElement(0x466e, "cover.constructor"), element(0x465c, [1, 2])),
				element(0x61a7, stringElement(0x466e, "cover_land.__proto__"), element(0x465c, [3, 4]))
			)
		)
		const { record } = await probe(file, "cover")

		expect(record?.cover?.mime).toBe("image/*")
		expect(record?.coverLand?.mime).toBe("image/*")
		expect(() => structuredClone(record)).not.toThrow()
	})

	it("hops at most a few blocks between attachments looking for the cover", async () => {
		const font = (index: number): Uint8Array =>
			element(0x61a7, stringElement(0x466e, `font${String(index)}.ttf`), element(0x465c, zeros(BLOCK_BYTES)))
		const attachments = element(
			0x1941a469,
			font(1),
			font(2),
			font(3),
			font(4),
			font(5),
			element(0x61a7, stringElement(0x466e, "cover.jpg"), element(0x465c, [0xff, 0xd8]))
		)
		const { record, reads } = await probe(mkv(INFO, tracks(VIDEO_TRACK), attachments), "cover")

		expect(record).toMatchObject({ cover: null, partial: true })
		expect(reads.length).toBe(5)
	})
})

describe("parseElementHeader", () => {
	it("accepts IDs of up to 4 bytes and sizes up to 2^53", () => {
		expect(parseElementHeader(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84]), 0)).toEqual({
			id: 0x1a45dfa3,
			start: 0,
			dataStart: 5,
			end: 9
		})
		expect(parseElementHeader(new Uint8Array([0x08, 0, 0, 0, 0, 0x81]), 0)).toBe("invalid")
		expect(parseElementHeader(new Uint8Array([0xec, 0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)).toMatchObject({
			dataStart: 9
		})
		expect(parseElementHeader(new Uint8Array([0xec, 0x01, 0x20, 0, 0, 0, 0, 0, 0]), 0)).toBe("invalid")
		expect(parseElementHeader(new Uint8Array([0xec, 0x00]), 0)).toBe("invalid")
		expect(parseElementHeader(new Uint8Array([0xff, 0x81]), 0)).toBe("invalid")
		expect(parseElementHeader(new Uint8Array([0xec, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)).toMatchObject({ end: null })
		expect(parseElementHeader(new Uint8Array([0x1a, 0x45]), 0)).toBe("short")
	})
})

// ── Review regressions ──

function mp4Video(entry: Uint8Array): Uint8Array {
	return concat(FTYP, box("moov", mvhd({ duration: 1000 }), trak(tkhd({ id: 1 }), [mdhd({}), hdlr("vide")], entry)))
}

const MAIN10_HVCC = box("hvcC", [1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93], zeros(4), [0xfa], zeros(5))

function doviBox(type: string, { profile, level, compat }: { profile: number; level: number; compat: number }): Uint8Array {
	return box(type, [1, 0, (profile << 1) | (level >> 5), (level & 31) << 3, compat << 4], zeros(19))
}

describe("probeVideo — review regressions (MP4)", () => {
	it("keeps the tracks and still filters chapter text when a box after them is broken", async () => {
		const video = trak(tkhd({ id: 1 }), [mdhd({}), hdlr("vide")], videoEntry("avc1", {}, AVCC), box("tref", box("chap", u32(2))))
		const chapters = trak(tkhd({ id: 2, enabled: false }), [mdhd({}), hdlr("text")], box("text", zeros(40)))
		const mvex = box("mvex", fullBox("mehd", 0, 0, u32(7000)))
		const broken = concat(u32(0), text("free"), zeros(8))
		const file = concat(FTYP, box("moov", mvhd({ duration: 0 }), video, chapters, mvex, broken))

		expect((await probe(file, "full")).record).toMatchObject({ partial: true, durationSec: 7, subs: [], video: { codec: "h264" } })
		const parsed = await walkContainer(new BlockSource(file.length, (start, end) => Promise.resolve(file.slice(start, end))), "card")

		expect(
			parsed?.tracks.map(track => (track.kind === "video" ? { kind: "video", codec: track.video.codec } : { kind: track.kind }))
		).toEqual([{ kind: "video", codec: "h264" }])
	})

	it("writes the Dolby Vision string only when no base layer is compatible", async () => {
		const profile5 = await probe(
			mp4Video(videoEntry("hvc1", {}, MAIN10_HVCC, doviBox("dvcC", { profile: 5, level: 6, compat: 0 }))),
			"card"
		)
		const profile5Hev1 = await probe(
			mp4Video(videoEntry("hev1", {}, MAIN10_HVCC, doviBox("dvcC", { profile: 5, level: 9, compat: 0 }))),
			"card"
		)
		const profile8 = await probe(
			mp4Video(videoEntry("hvc1", {}, MAIN10_HVCC, doviBox("dvcC", { profile: 8, level: 6, compat: 1 }))),
			"card"
		)
		const av1 = await probe(
			mp4Video(videoEntry("av01", {}, box("av1C", [0x81, 0x08, 0x4c, 0x00]), doviBox("dvvC", { profile: 10, level: 33, compat: 0 }))),
			"card"
		)

		expect(profile5.record?.video).toMatchObject({ codecString: "dvh1.05.06", dv: { profile: 5, compat: 0 } })
		expect(profile5Hev1.record?.video?.codecString).toBe("dvhe.05.09")
		expect(profile8.record?.video).toMatchObject({ codecString: "hvc1.2.4.L93.90", dv: { profile: 8, compat: 1 } })
		expect(av1.record?.video?.codecString).toBe("dav1.10.33")
	})

	it("degrades a trak with a too-short stsd instead of rejecting the probe", async () => {
		const shortStsd = box(
			"trak",
			tkhd({ id: 1 }),
			box("mdia", mdhd({}), hdlr("vide"), box("minf", box("stbl", fullBox("stsd", 0, 0, [0, 0]))))
		)
		const file = concat(FTYP, box("moov", mvhd({ duration: 1000 }), shortStsd, aacTrak(2)))

		expect((await probe(file, "full")).record).toMatchObject({ partial: true, video: null, audio: [{ id: 2 }] })
	})

	it("finds nclx behind an ICC colr and ignores an nclx too short to hold its range flag", async () => {
		const icc = box("colr", text("prof"), zeros(16))
		const nclx = box("colr", text("nclx"), u16(9), u16(16), u16(9), [0x80])
		const truncated = box("colr", text("nclx"), u16(9), u16(18), u16(9))
		const behindIcc = await probe(mp4Video(videoEntry("hvc1", {}, MAIN10_HVCC, icc, nclx)), "card")
		const tooShort = await probe(mp4Video(videoEntry("hvc1", {}, MAIN10_HVCC, truncated, zeros(8))), "card")

		expect(behindIcc.record?.video?.transfer).toBe("pq")
		expect(tooShort.record?.video?.transfer).toBe("sdr")
	})

	it("reads an ISO AudioSampleEntryV1 (stsd version 1) without QuickTime's 16 extra bytes", async () => {
		const entry = box(
			"mp4a",
			zeros(6),
			u16(1),
			u16(1),
			zeros(6),
			u16(2),
			u16(16),
			zeros(4),
			u32(48000 * 0x10000),
			esds(0x40, AAC_LC_48K_STEREO)
		)
		const stsdV1 = fullBox("stsd", 1, 0, u32(1), entry)
		const audio = box("trak", tkhd({ id: 1 }), box("mdia", mdhd({}), hdlr("soun"), box("minf", box("stbl", stsdV1))))
		const file = concat(FTYP, box("moov", mvhd({ duration: 1000 }), audio))

		expect((await probe(file, "card")).record?.audio).toMatchObject([{ codec: "aac", codecString: "mp4a.40.2", ch: 2, rate: 48000 }])
	})

	it("keeps the type of a sample entry cut short at the read cap", async () => {
		const file = mp4Video(videoEntry("hvc1", {}, MAIN10_HVCC, box("free", zeros(300 * 1024))))

		expect((await probe(file, "card")).record?.video).toMatchObject({ codec: "hevc", fourcc: "hvc1", codecString: "hvc1.2.4.L93.90" })
	})

	it("reads a header near a block's end without downloading the next block", async () => {
		const head = concat(FTYP, box("free", zeros(BLOCK_BYTES - FTYP.length - 8 - 8)))
		const file = concat(head, box("mdat", zeros(64)))
		const { record, reads } = await probe(file, "card")

		expect(record).toMatchObject({ partial: true, video: null })
		expect(reads).toEqual([0])
	})
})

describe("probeVideo — review regressions (Matroska)", () => {
	it("survives a run of corrupt headers that each look like a Cluster, scanning the block once", async () => {
		const junk = concat(...Array.from({ length: 50_000 }, () => [0x1f, 0x43, 0xb6, 0x75, 0x00]))
		const file = concat(ebmlHeader(), segment(new Uint8Array([0x00]), junk))
		const started = performance.now()
		const { record, reads } = await probe(file, "card")

		expect(record).toMatchObject({ partial: true, video: null })
		expect(reads).toEqual([0])
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("inflates in small slices and stops at the cap without decompressing the rest", async () => {
		const RealStream = DecompressionStream
		let produced = 0

		vi.stubGlobal(
			"DecompressionStream",
			class {
				public readonly writable: WritableStream<BufferSource>
				public readonly readable: ReadableStream<Uint8Array>

				public constructor(format: CompressionFormat) {
					const real = new RealStream(format)
					const counter = new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							produced += chunk.length
							controller.enqueue(chunk)
						}
					})

					this.writable = real.writable
					this.readable = real.readable.pipeThrough(counter)
				}
			}
		)

		expect(await inflateCapped(deflateSync(Buffer.alloc(256 * 1024 * 1024)), 1024 * 1024)).toBeNull()
		expect(produced).toBeLessThan(4 * 1024 * 1024)
	})

	it("decompresses CodecPrivate only for codecs that read it", async () => {
		const construct = vi.fn()
		const RealStream = DecompressionStream

		vi.stubGlobal(
			"DecompressionStream",
			class extends RealStream {
				public constructor(format: CompressionFormat) {
					super(format)
					construct()
				}
			}
		)

		const zlib = element(0x6d80, element(0x6240, uintElement(0x5032, 2), element(0x5034, uintElement(0x4254, 0))))
		const flac = trackEntry(1, 2, "A_FLAC", element(0x63a2, deflateSync(Buffer.from("fLaC"))), zlib)

		expect((await probe(mkv(INFO, tracks(flac)), "card")).record?.audio).toMatchObject([{ codec: "flac", codecString: "flac" }])
		expect(construct).not.toHaveBeenCalled()
	})

	it("reads empty elements as their declared defaults", async () => {
		const info = element(0x1549a966, element(0x2ad7b1), element(0x4489, f64(2000)))
		const audio = trackEntry(2, 2, "A_FLAC", element(0x88), element(0xb9), element(0xe1, element(0xb5), element(0x9f)))
		const record = (await probe(mkv(info, tracks(audio)), "card")).record

		expect(record?.durationSec).toBe(2)
		expect(record?.audio).toMatchObject([{ def: true, ch: 1, rate: 8000 }])
	})

	it("shows no chapters when every edition is hidden", async () => {
		const chapters = element(0x1043a770, element(0x45b9, uintElement(0x45bd, 1), atom(0, "Hidden")))

		expect((await probe(mkv(INFO, tracks(VIDEO_TRACK), chapters), "full")).record?.chapters).toEqual([])
	})

	it("keeps the earliest 64 chapters of an edition stored out of order", async () => {
		const atoms = Array.from({ length: 70 }, (_, index) => atom(69 - index, `Chapter ${String(69 - index)}`))
		const chapters = (await probe(mkv(INFO, tracks(VIDEO_TRACK), element(0x1043a770, element(0x45b9, ...atoms))), "full")).record
			?.chapters

		expect(chapters?.length).toBe(64)
		expect(chapters?.[0]?.t).toBe(0)
		expect(chapters?.[63]?.t).toBe(63)
	})

	it("reads a Cluster header ending at a block boundary without downloading the next block", async () => {
		const prefix = concat(ebmlHeader(), [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], tracks(VIDEO_TRACK))
		const voidSize = BLOCK_BYTES - prefix.length - 8 - 8
		const file = concat(prefix, element(0xec, zeros(voidSize)), element(0x1f43b675, zeros(64)))
		const { record, reads } = await probe(file, "card")

		expect(record?.video?.codec).toBe("h264")
		expect(reads).toEqual([0])
	})

	it("never downloads for an attachment name once the cover hops are spent", async () => {
		const prefixLength = ebmlHeader().length + 12 + 8
		const attachedFile = (name: string, start: number, nextStart: number): Uint8Array =>
			element(0x61a7, stringElement(0x466e, name), element(0x465c, zeros(nextStart - start - 6 - (6 + name.length) - 6)))
		const files: Uint8Array[] = []
		let at = prefixLength

		for (let index = 1; index <= 4; index++) {
			const next = index === 4 ? 5 * BLOCK_BYTES - 14 : index * BLOCK_BYTES + 10
			const name = `font${String(index)}.ttf`

			files.push(attachedFile(name, at, next))
			at = next
		}

		files.push(element(0x61a7, stringElement(0x466e, "font5.ttf"), element(0x465c, zeros(16))))

		const file = concat(ebmlHeader(), segment(element(0x1941a469, ...files)))
		const { record, reads } = await probe(file, "cover")

		expect(record).toMatchObject({ cover: null, partial: true })
		expect(reads).toEqual([0, 1, 2, 3, 4])
	})

	it("moves past SeekHead entries that point at no SeekHead to a later one that does", async () => {
		const cluster = element(0x1f43b675, zeros(16))
		const trackList = tracks(VIDEO_TRACK)
		const placeholder = seekHead([
			[0x1549a966, 0],
			[0x114d9b74, 0],
			[0x114d9b74, 0],
			[0x114d9b74, 0]
		])
		const infoAt = placeholder.length
		const clusterAt = infoAt + INFO.length
		const tracksAt = clusterAt + cluster.length
		const secondaryAt = tracksAt + trackList.length
		const primary = seekHead([
			[0x1549a966, infoAt],
			[0x114d9b74, infoAt],
			[0x114d9b74, clusterAt],
			[0x114d9b74, secondaryAt]
		])
		const file = mkv(primary, INFO, cluster, trackList, seekHead([[0x1654ae6b, tracksAt]]))

		expect((await probe(file, "card")).record?.video?.codec).toBe("h264")
	})

	it("writes the Dolby Vision string for an AV1 track with no compatible base layer", async () => {
		const mapping = element(0x41e4, uintElement(0x41e7, 0x64767643), element(0x41ed, [1, 0, 10 << 1, 6 << 3, 0], zeros(19)))
		const file = mkv(INFO, tracks(trackEntry(1, 1, "V_AV1", element(0x63a2, [0x81, 0x08, 0x4c, 0x00]), mapping)))

		expect((await probe(file, "card")).record?.video).toMatchObject({ codecString: "dav1.10.06", dv: { profile: 10, compat: 0 } })
	})
})

describe("BlockSource reads outside the file", () => {
	it("rejects them up front instead of spinning at a block-aligned end", async () => {
		const source = new BlockSource(BLOCK_BYTES, () => Promise.resolve(new Uint8Array(BLOCK_BYTES)))

		await expect(source.read(new Uint8Array(1), BLOCK_BYTES, 1)).rejects.toBeInstanceOf(OutOfFileReadError)
		await expect(source.read(new Uint8Array(1), -1, 1)).rejects.toBeInstanceOf(OutOfFileReadError)
		await expect(source.read(new Uint8Array(0), BLOCK_BYTES, 0)).resolves.toBeUndefined()
	})
})

describe("walkContainer — ALAC's decoder configuration", () => {
	const cookie = Uint8Array.from({ length: 24 }, (_, i) => i + 1)

	it("takes the magic cookie from an MP4 sample entry's alac box", async () => {
		const file = concat(
			FTYP,
			box(
				"moov",
				mvhd({}),
				trak(tkhd({ id: 1 }), [mdhd({}), hdlr("soun")], audioEntry("alac", { rate: 44_100 }, fullBox("alac", 0, 0, cookie)))
			)
		)
		const parsed = await walkContainer(new BlockSource(file.length, (start, end) => Promise.resolve(file.slice(start, end))), "card")
		const track = parsed?.tracks[0]

		expect(track?.kind === "audio" ? [track.audio.codec, Array.from(track.config ?? [])] : null).toEqual([
			"alac",
			[0, 0, 0, 0, ...cookie]
		])
	})

	it("takes it from a Matroska track's CodecPrivate, and keeps it off the stored probe", async () => {
		const file = mkv(INFO, tracks(trackEntry(1, 2, "A_ALAC", element(0x63a2, cookie), element(0xe1, uintElement(0x9f, 2)))))
		const parsed = await walkContainer(new BlockSource(file.length, (start, end) => Promise.resolve(file.slice(start, end))), "card")
		const track = parsed?.tracks[0]

		expect(track?.kind === "audio" ? [track.audio.codec, track.config] : null).toEqual(["alac", cookie])
		expect(JSON.stringify((await probe(file, "card")).record)).not.toContain("config")
	})
})
