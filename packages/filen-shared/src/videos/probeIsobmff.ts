import {
	av1CodecString,
	avcCodecString,
	dolbyVisionCodecString,
	dtsCodecString,
	hevcCodecString,
	mp4aCodecString,
	parseAudioSpecificConfig,
	parseAv1C,
	parseAvcC,
	parseHvcC,
	parseVpcC,
	simpleAudioCodecString,
	vp9CodecString,
	type ColourInfo
} from "./codecString"
import { BLOCK_BYTES, BlockReadError, ReadBudgetError, type BlockSource } from "./blockSource"
import { LEADING_BOXES } from "./transportStreamHead"
import { MAX_MFRA_BYTES, fragmentEnd, lastMoof, readMfra, readMoof, type FragmentDefaults, type FragmentIndex } from "./probeFragments"
import {
	MalformedError,
	ascii,
	int32,
	parseDolbyVision,
	raiseBudget,
	readBytes,
	seconds,
	sniffImageMime,
	transferKind,
	uint16,
	uint32,
	uint64,
	utf8
} from "./probeBytes"
import {
	MAX_CHAPTERS,
	type MediaCodec,
	type ParsedContainer,
	type ParsedTrack,
	type ProbeChapter,
	type ProbeTier,
	type SampleTables
} from "./probeTypes"

// MP4/MOV/M4V (ISO BMFF) walked box header by box header: payloads are read only for the few small boxes
// a probe needs, and the large sample tables are skipped by their sizes, so a 4 MiB `moov` costs a read
// per block that holds a header the walk visits, never the whole box.

// Top-level boxes visited looking for `moov`; past this the file is not shaped like one to read.
const MAX_TOP_LEVEL_BOXES = 64
const MAX_CHILDREN = 1024
const MAX_BOXES = 8192
const MAX_DEPTH = 10
// The first sample entry holds the codec config; an x265 hvcC with its SEI is a few KiB.
const MAX_SAMPLE_ENTRY_BYTES = 262_144
// 255 chapters of 255-byte titles.
const MAX_CHPL_BYTES = 131_072
const MAX_STRING_BYTES = 4096
const MAX_FTYP_BYTES = 256

interface Box {
	type: string
	start: number
	dataStart: number
	end: number
}

interface Walk {
	source: BlockSource
	tier: ProbeTier
	result: ParsedContainer
	boxes: number
	fragmented: boolean
	fragmentDuration: number | null
	timescale: number
	// mdhd timescale per track ID, and mvex's trex defaults: what a fragmented file's moofs are read with.
	timescales: Map<number, number>
	fragmentDefaults: Map<number, FragmentDefaults>
	// mvhd's next_track_ID: one past the highest track ID, so the card can stop once it has seen that many.
	nextTrackId: number
	// The whole moov was walked, so the absence of `mvex` is known.
	moovComplete: boolean
	// Tracks a `tref`/`chap` names as QuickTime chapter text, which are not subtitles.
	chapterTracks: Set<number>
	// No ftyp, a QuickTime major brand, or a QuickTime compatible brand.
	quickTime: boolean
	// The moov walk stopped early: at the tier's read budget (an incomplete track list) or at a broken
	// box (every track before it stands, if there were any).
	cut: "budget" | "malformed" | null
	// Locate the picture track's sample tables too (walkContainer's `keyframes`).
	keyframes: boolean
}

// The box header at `at` inside [at, limit). A size of 0 ("to the end") is only legal at the top level.
async function boxHeader(walk: Walk, at: number, limit: number, topLevel: boolean): Promise<Box> {
	walk.boxes++

	if (walk.boxes > MAX_BOXES) {
		throw new MalformedError("too many boxes")
	}

	if (limit - at < 8) {
		throw new MalformedError("short box header")
	}

	// Most headers are 8 bytes: the read stops at the block's end and only goes on for a 64-bit size.
	const full = Math.min(16, limit - at)
	const inBlock = Math.min(full, (Math.floor(at / BLOCK_BYTES) + 1) * BLOCK_BYTES - at)
	let header = await readBytes(walk.source, at, Math.max(8, inBlock))

	if (header.length < full && uint32(header, 0) === 1) {
		header = await readBytes(walk.source, at, full)
	}

	const size32 = uint32(header, 0)
	let size: number | null = size32
	let dataStart = at + 8

	if (size32 === 1) {
		size = header.length < 16 ? null : uint64(header, 8)
		dataStart = at + 16
	} else if (size32 === 0) {
		size = topLevel ? limit - at : null
	}

	if (size === null || size < dataStart - at || at + size > limit) {
		throw new MalformedError("box past its parent")
	}

	return { type: ascii(header, 4, 8), start: at, dataStart, end: at + size }
}

// Visits each child of `parent` in order until `visit` returns false.
async function forEachChild(walk: Walk, parent: Box, depth: number, visit: (box: Box) => Promise<unknown>): Promise<void> {
	if (depth > MAX_DEPTH) {
		throw new MalformedError("boxes nested too deep")
	}

	let at = parent.dataStart

	for (let count = 0; at + 8 <= parent.end; count++) {
		if (count >= MAX_CHILDREN) {
			throw new MalformedError("too many child boxes")
		}

		const box = await boxHeader(walk, at, parent.end, false)

		if ((await visit(box)) === false) {
			return
		}

		at = box.end
	}
}

async function payload(walk: Walk, box: Box, max: number): Promise<Uint8Array> {
	return readBytes(walk.source, box.dataStart, Math.min(max, box.end - box.dataStart))
}

// ── In-memory boxes (inside a sample entry) ─────────────────────────────────

function memBox(bytes: Uint8Array, at: number, end: number): Box | null {
	if (at + 8 > end) {
		return null
	}

	const size = uint32(bytes, at)

	if (size < 8 || at + size > end) {
		return null
	}

	return { type: ascii(bytes, at + 4, at + 8), start: at, dataStart: at + 8, end: at + size }
}

function memChildren(bytes: Uint8Array, start: number, end: number): Box[] {
	const children: Box[] = []
	let at = start

	while (children.length < MAX_CHILDREN) {
		const box = memBox(bytes, at, end)

		if (box === null) {
			break
		}

		children.push(box)
		at = box.end
	}

	return children
}

function memChild(bytes: Uint8Array, start: number, end: number, type: string): Box | null {
	return memChildren(bytes, start, end).find(box => box.type === type) ?? null
}

// ── Sample entries ──────────────────────────────────────────────────────────

const VIDEO_ENTRIES: Readonly<Record<string, MediaCodec>> = {
	avc1: "h264",
	avc3: "h264",
	dva1: "h264",
	dvav: "h264",
	hvc1: "hevc",
	hev1: "hevc",
	dvh1: "hevc",
	dvhe: "hevc",
	av01: "av1",
	dav1: "av1",
	vp09: "vp9",
	vp08: "vp8"
}

const AUDIO_ENTRIES: Readonly<Record<string, MediaCodec>> = {
	"ac-3": "ac3",
	"ec-3": "eac3",
	dtsc: "dts",
	dtsh: "dts",
	dtsl: "dts",
	dtse: "dts",
	mlpa: "truehd",
	Opus: "opus",
	fLaC: "flac",
	alac: "alac",
	".mp3": "mp3"
}

// ISO/IEC 14496-1 objectTypeIndication values an `esds` names.
const OBJECT_TYPES: Readonly<Record<number, MediaCodec>> = {
	0x20: "mpeg4",
	0x40: "aac",
	0x66: "aac",
	0x67: "aac",
	0x68: "aac",
	0x69: "mp3",
	0x6b: "mp3",
	0xa5: "ac3",
	0xa6: "eac3",
	0xa9: "dts",
	0xaa: "dts",
	0xab: "dts",
	0xac: "dts",
	0xad: "opus"
}

// A descriptor's tag and payload; its length is 1-4 bytes of 7 bits each, high bit set on all but the last.
function descriptorAt(bytes: Uint8Array, at: number, end: number): { tag: number; start: number; end: number } | null {
	const tag = bytes[at]
	let length = 0
	let cursor = at + 1

	for (let i = 0; i < 4 && cursor < end; i++) {
		const byte = bytes[cursor] ?? 0

		cursor++
		length = length * 128 + (byte & 0x7f)

		if ((byte & 0x80) === 0) {
			return tag === undefined || cursor + length > end ? null : { tag, start: cursor, end: cursor + length }
		}
	}

	return null
}

// esds: ES_Descriptor (3) → DecoderConfigDescriptor (4: object type first) → DecoderSpecificInfo (5).
function parseEsds(bytes: Uint8Array, esds: Box): { objectType: number; config: Uint8Array | null } | null {
	const es = descriptorAt(bytes, esds.dataStart + 4, esds.end)

	if (es?.tag !== 3) {
		return null
	}

	const flags = bytes[es.start + 2] ?? 0
	let at = es.start + 3

	if ((flags & 0x80) !== 0) {
		at += 2
	}

	if ((flags & 0x40) !== 0) {
		at += 1 + (bytes[at] ?? 0)
	}

	if ((flags & 0x20) !== 0) {
		at += 2
	}

	const decoderConfig = descriptorAt(bytes, at, es.end)
	const objectType = decoderConfig === null ? undefined : bytes[decoderConfig.start]

	if (decoderConfig?.tag !== 4 || objectType === undefined) {
		return null
	}

	const specific = descriptorAt(bytes, decoderConfig.start + 13, decoderConfig.end)

	return { objectType, config: specific?.tag === 5 ? bytes.slice(specific.start, specific.end) : null }
}

// The original format of an encrypted (encv/enca) entry, from sinf → frma.
function originalFormat(bytes: Uint8Array, children: number, end: number, type: string): string {
	if (type !== "encv" && type !== "enca") {
		return type
	}

	const sinf = memChild(bytes, children, end, "sinf")
	const frma = sinf === null ? null : memChild(bytes, sinf.dataStart, sinf.end, "frma")

	return frma === null ? type : ascii(bytes, frma.dataStart, frma.dataStart + 4)
}

// The colour description among an entry's `colr` boxes: nclx (ISO) or nclc (QuickTime); an ICC profile
// box before it does not hide it. nclx carries its full-range flag in an 11th byte.
function colourOf(bytes: Uint8Array, boxes: readonly Box[]): ColourInfo | null {
	for (const colr of boxes) {
		const kind = ascii(bytes, colr.dataStart, colr.dataStart + 4)
		const length = colr.end - colr.dataStart

		if ((kind === "nclx" && length >= 11) || (kind === "nclc" && length >= 10)) {
			return {
				primaries: uint16(bytes, colr.dataStart + 4),
				transfer: uint16(bytes, colr.dataStart + 6),
				matrix: uint16(bytes, colr.dataStart + 8),
				fullRange: kind === "nclx" && ((bytes[colr.dataStart + 10] ?? 0) & 0x80) !== 0
			}
		}
	}

	return null
}

// The sample entry box; its type survives an entry cut short at MAX_SAMPLE_ENTRY_BYTES.
function entryBox(entry: Uint8Array): Box {
	return memBox(entry, 0, entry.length) ?? { type: ascii(entry, 4, 8), start: 0, dataStart: 8, end: entry.length }
}

interface TrackHeader {
	id: number
	enabled: boolean
	rotation: number
}

// The sample entry child a decoder is configured with, for the codecs that have one.
const DESCRIPTION_BOXES: Partial<Record<MediaCodec, string>> = { h264: "avcC", hevc: "hvcC", av1: "av1C" }

function videoTrack(entry: Uint8Array, header: TrackHeader, tables: SampleTables | null): ParsedTrack {
	const box = entryBox(entry)
	const children = box.dataStart + 78
	const fourcc = originalFormat(entry, children, box.end, box.type)
	const child = (type: string): Uint8Array | null => {
		const found = memChild(entry, children, box.end, type)

		return found === null ? null : entry.subarray(found.dataStart, found.end)
	}
	const colour = colourOf(
		entry,
		memChildren(entry, children, box.end).filter(item => item.type === "colr")
	)
	let codec: MediaCodec | null = VIDEO_ENTRIES[fourcc] ?? null
	let codecString: string | null = null
	let bitDepth: number | null = null
	let transfer = colour?.transfer ?? null

	if (codec === "h264") {
		const avcC = child("avcC")

		codecString = avcC === null ? null : avcCodecString({ fourcc, avcC })
		bitDepth = avcC === null ? null : (parseAvcC(avcC)?.bitDepth ?? null)
	} else if (codec === "hevc") {
		const hvcC = child("hvcC")

		codecString = hvcC === null ? null : hevcCodecString({ fourcc: fourcc === "hev1" || fourcc === "dvhe" ? "hev1" : "hvc1", hvcC })
		bitDepth = hvcC === null ? null : (parseHvcC(hvcC)?.bitDepth ?? null)
	} else if (codec === "av1") {
		const av1C = child("av1C")

		codecString = av1C === null ? null : av1CodecString({ av1C, colour })
		bitDepth = av1C === null ? null : (parseAv1C(av1C)?.bitDepth ?? null)
	} else if (codec === "vp9") {
		const vpcC = child("vpcC")
		const config = vpcC === null ? null : parseVpcC(vpcC)

		codecString = config === null ? null : vp9CodecString(config)
		bitDepth = config?.bitDepth ?? null
		transfer ??= config?.colour?.transfer ?? null
	} else if (codec === "vp8") {
		codecString = "vp8"
		bitDepth = 8
	} else if (fourcc === "mp4v") {
		const esds = memChild(entry, children, box.end, "esds")
		const objectType = esds === null ? null : (parseEsds(entry, esds)?.objectType ?? null)

		codec = objectType === null ? null : (OBJECT_TYPES[objectType] ?? null)
	}

	const pasp = memChild(entry, children, box.end, "pasp")
	const hSpacing = pasp === null ? 0 : uint32(entry, pasp.dataStart)
	const vSpacing = pasp === null ? 0 : uint32(entry, pasp.dataStart + 4)
	const dvConfig = child("dvcC") ?? child("dvvC") ?? child("dvwC")
	const dv = dvConfig === null ? null : parseDolbyVision(dvConfig)

	// Without a compatible base layer only a Dolby Vision decoder can show the picture.
	if (dv !== null && dv.compat === 0) {
		codecString = dolbyVisionCodecString({ fourcc, profile: dv.profile, level: dv.level }) ?? codecString
	}

	const descriptionBox = codec === null ? undefined : DESCRIPTION_BOXES[codec]

	return {
		kind: "video",
		enabled: header.enabled,
		...(tables === null
			? {}
			: {
					decode: {
						track: header.id,
						description: descriptionBox === undefined ? null : child(descriptionBox),
						encodedFrames: false,
						tables
					}
				}),
		video: {
			codec,
			fourcc,
			codecString,
			w: uint16(entry, box.dataStart + 24),
			h: uint16(entry, box.dataStart + 26),
			par: hSpacing > 0 && vSpacing > 0 ? Math.round((hSpacing / vSpacing) * 10_000) / 10_000 : 1,
			rotation: header.rotation,
			bitDepth,
			transfer: transferKind(transfer),
			...(dv === null ? {} : { dv: { profile: dv.profile, compat: dv.compat } })
		}
	}
}

// Channels by AC-3/E-AC-3 acmod (without the LFE), and sample rates by fscod.
export const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5]
export const AC3_RATES = [48000, 44100, 32000]

// dac3: fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1).
function ac3Format(dac3: Uint8Array): { ch: number; rate: number | null } | null {
	if (dac3.length < 3) {
		return null
	}

	const acmod = ((dac3[1] ?? 0) >> 3) & 0x07
	const lfe = ((dac3[1] ?? 0) >> 2) & 1

	return { ch: (AC3_CHANNELS[acmod] ?? 2) + lfe, rate: AC3_RATES[(dac3[0] ?? 0) >> 6] ?? null }
}

// Channels each chan_loc bit of a dependent E-AC-3 substream adds (ETSI TS 102 366 Table E.1.4).
const EAC3_LOCATION_CHANNELS = [2, 2, 1, 1, 2, 2, 2, 1, 1]

// dec3: data_rate(13) num_ind_sub(3), then the first independent substream's fscod, acmod, lfeon and
// its dependent substreams' channel locations.
function eac3Format(dec3: Uint8Array): { ch: number; rate: number | null } | null {
	if (dec3.length < 5) {
		return null
	}

	const fscod = (dec3[2] ?? 0) >> 6
	const acmod = ((dec3[3] ?? 0) >> 1) & 0x07
	const lfe = (dec3[3] ?? 0) & 1
	const dependents = ((dec3[4] ?? 0) >> 1) & 0x0f
	let ch = (AC3_CHANNELS[acmod] ?? 2) + lfe

	if (dependents > 0 && dec3.length >= 6) {
		const locations = (((dec3[4] ?? 0) & 1) << 8) | (dec3[5] ?? 0)

		for (let bit = 0; bit < 9; bit++) {
			if ((locations & (1 << (8 - bit))) !== 0) {
				ch += EAC3_LOCATION_CHANNELS[bit] ?? 0
			}
		}
	}

	return { ch, rate: AC3_RATES[fscod] ?? null }
}

interface AudioContext {
	header: TrackHeader
	lang: string | null
	name: string | null
	// The entry's version field means a QuickTime sound description (see walkIsobmff), not ISO's
	// AudioSampleEntryV1, which keeps the 28-byte layout.
	quickTimeLayout: boolean
}

function audioTrack(entry: Uint8Array, { header, lang, name, quickTimeLayout }: AudioContext): ParsedTrack {
	const box = entryBox(entry)
	// QuickTime sound descriptions: version 1 adds 16 bytes, version 2 replaces the fields with 36.
	const version = quickTimeLayout ? uint16(entry, box.dataStart + 8) : 0
	const children = box.dataStart + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
	const fourcc = originalFormat(entry, children, box.end, box.type)
	const child = (type: string): Uint8Array | null => {
		const found = memChild(entry, children, box.end, type)

		return found === null ? null : entry.subarray(found.dataStart, found.end)
	}
	let ch: number | null = version === 2 ? uint32(entry, box.dataStart + 40) : uint16(entry, box.dataStart + 16)
	let rate: number | null = uint16(entry, box.dataStart + 24)

	if (version === 2) {
		rate =
			entry.length >= box.dataStart + 40
				? Math.round(new DataView(entry.buffer, entry.byteOffset).getFloat64(box.dataStart + 32))
				: null
	}
	let codec: MediaCodec | null = AUDIO_ENTRIES[fourcc] ?? null
	let codecString: string | null = null

	if (fourcc === "mp4a") {
		const wave = memChild(entry, children, box.end, "wave")
		const esds =
			memChild(entry, children, box.end, "esds") ?? (wave === null ? null : memChild(entry, wave.dataStart, wave.end, "esds"))
		const parsed = esds === null ? null : parseEsds(entry, esds)

		if (parsed !== null) {
			codec = OBJECT_TYPES[parsed.objectType] ?? null
			codecString = mp4aCodecString({ objectTypeIndication: parsed.objectType, audioSpecificConfig: parsed.config })

			const config = parsed.objectType === 0x40 && parsed.config !== null ? parseAudioSpecificConfig(parsed.config) : null

			ch = config?.channels ?? ch
			rate = config?.sampleRate ?? rate
		}
	} else if (codec === "ac3" || codec === "eac3") {
		const config = child(codec === "ac3" ? "dac3" : "dec3")
		const format = config === null ? null : codec === "ac3" ? ac3Format(config) : eac3Format(config)

		codecString = simpleAudioCodecString(codec)
		ch = format?.ch ?? ch
		rate = format?.rate ?? rate
	} else if (codec === "opus") {
		const dOps = child("dOps")

		codecString = "opus"
		ch = dOps?.[1] ?? ch
		// Opus always decodes at 48 kHz; dOps's rate is only the source's.
		rate = 48000
	} else if (codec === "flac") {
		const dfLa = child("dfLa")

		codecString = "flac"

		// A full box and the STREAMINFO block header, then sample rate (20 bits) and channels (3 bits) at 10-12.
		if (dfLa !== null && dfLa.length >= 21) {
			rate = ((dfLa[18] ?? 0) << 12) + ((dfLa[19] ?? 0) << 4) + ((dfLa[20] ?? 0) >> 4)
			ch = (((dfLa[20] ?? 0) >> 1) & 0x07) + 1
		}
	} else if (codec === "dts") {
		codecString = dtsCodecString(fourcc)
	} else if (codec === "truehd" || codec === "alac" || codec === "mp3") {
		codecString = simpleAudioCodecString(codec)
	}

	return {
		kind: "audio",
		enabled: header.enabled,
		// ALAC's magic cookie: the `alac` box inside the entry of the same name (version, flags, the config).
		...(codec === "alac" ? { config: child("alac") } : {}),
		audio: {
			id: header.id,
			codec,
			codecString,
			ch: ch === 0 ? null : ch,
			rate: rate === 0 ? null : rate,
			lang,
			name,
			def: header.enabled,
			forced: false,
			commentary: false
		}
	}
}

// ── Track and movie boxes ───────────────────────────────────────────────────

// tkhd: the enabled flag, the track ID and the display matrix's turn, snapped to a right angle.
function parseTkhd(bytes: Uint8Array): TrackHeader {
	const version = bytes[0] ?? 0
	const matrix = version === 1 ? 52 : 40
	const a = int32(bytes, matrix)
	const b = int32(bytes, matrix + 4)
	const degrees = Math.round(((Math.atan2(b, a) * 180) / Math.PI / 90) % 4) * 90

	return {
		id: uint32(bytes, version === 1 ? 20 : 12),
		enabled: ((bytes[3] ?? 0) & 1) === 1,
		rotation: (degrees + 360) % 360
	}
}

// mdhd's ticks per second.
function mdhdTimescale(bytes: Uint8Array): number {
	return uint32(bytes, (bytes[0] ?? 0) === 1 ? 20 : 12)
}

// mdhd's packed ISO 639-2/T code (three 5-bit letters); QuickTime's Macintosh codes below 0x400 are not mapped.
function mdhdLanguage(bytes: Uint8Array): string | null {
	const at = (bytes[0] ?? 0) === 1 ? 32 : 20
	const packed = uint16(bytes, at)

	if (packed < 0x400 || packed === 0x7fff) {
		return null
	}

	const code = String.fromCharCode(((packed >> 10) & 0x1f) + 0x60, ((packed >> 5) & 0x1f) + 0x60, (packed & 0x1f) + 0x60)

	return code === "und" ? null : code
}

// A `name` user-data string: plain text, or an iTunes-style `data` box around it.
function userDataString(bytes: Uint8Array): string | null {
	if (ascii(bytes, 4, 8) === "data") {
		return utf8(bytes, 16, bytes.length)
	}

	return utf8(bytes, 0, bytes.length)
}

const SUBTITLE_HANDLERS = new Set(["text", "sbtl", "subt"])

interface TrakState {
	header: TrackHeader
	handler: string
	lang: string | null
	bcp47: string | null
	name: string | null
	timescale: number
	entry: SampleEntry | null
}

async function walkTrak(walk: Walk, trak: Box): Promise<ParsedTrack | null> {
	const state: TrakState = {
		header: { id: 0, enabled: true, rotation: 0 },
		handler: "",
		lang: null,
		bcp47: null,
		name: null,
		timescale: 0,
		entry: null
	}

	await forEachChild(walk, trak, 2, async box => {
		if (box.type === "tkhd") {
			state.header = parseTkhd(await payload(walk, box, 104))
		} else if (box.type === "tref") {
			const bytes = await payload(walk, box, MAX_STRING_BYTES)

			for (const reference of memChildren(bytes, 0, bytes.length)) {
				for (let at = reference.dataStart; reference.type === "chap" && at + 4 <= reference.end; at += 4) {
					walk.chapterTracks.add(uint32(bytes, at))
				}
			}
		} else if (box.type === "udta" && walk.tier === "full") {
			await forEachChild(walk, box, 3, async item => {
				if (item.type === "name") {
					state.name = userDataString(await payload(walk, item, MAX_STRING_BYTES))
				}
			})
		} else if (box.type === "mdia") {
			await forEachChild(walk, box, 3, async child => {
				if (child.type === "mdhd") {
					const mdhd = await payload(walk, child, 36)

					state.lang = mdhdLanguage(mdhd)
					state.timescale = mdhdTimescale(mdhd)
				} else if (child.type === "elng") {
					state.bcp47 = utf8(await payload(walk, child, MAX_STRING_BYTES), 4, child.end - child.dataStart)
				} else if (child.type === "hdlr") {
					state.handler = ascii(await payload(walk, child, 12), 8, 12)
				} else if (child.type === "minf") {
					// hdlr precedes minf, so only a picture track pays for locating its tables.
					state.entry = await firstSampleEntry(walk, child, walk.keyframes && state.handler === "vide")
				}
			})

			// The card needs nothing after the media box; the user data with the name comes later.
			return walk.tier === "full"
		}

		return true
	})

	const { header, handler, entry, name } = state
	const language = state.bcp47 ?? state.lang

	walk.timescales.set(header.id, state.timescale)

	if (entry === null) {
		return null
	}

	if (handler === "vide") {
		return videoTrack(entry.bytes, header, entry.tables === null ? null : { ...entry.tables, timescale: state.timescale })
	}

	if (handler === "soun") {
		// Like ffmpeg: QuickTime files, and ISO files whose stsd version 0 still carries a versioned entry.
		return audioTrack(entry.bytes, { header, lang: language, name, quickTimeLayout: walk.quickTime || entry.stsdVersion === 0 })
	}

	if (SUBTITLE_HANDLERS.has(handler)) {
		return {
			kind: "subtitle",
			enabled: header.enabled,
			sub: {
				id: header.id,
				codecId: ascii(entry.bytes, 4, 8),
				lang: language,
				name,
				def: header.enabled,
				forced: false,
				hi: false
			}
		}
	}

	return null
}

interface SampleEntry {
	bytes: Uint8Array
	stsdVersion: number
	// Located only when asked for; the timescale is filled in by the trak.
	tables: Omit<SampleTables, "timescale"> | null
}

function range(box: Box): { start: number; end: number } {
	return { start: box.dataStart, end: box.end }
}

// minf → stbl → stsd's first entry, read whole; the sample tables after it are skipped by size, or with
// `locateTables` located by their headers (never read).
async function firstSampleEntry(walk: Walk, minf: Box, locateTables: boolean): Promise<SampleEntry | null> {
	const found: { entry: SampleEntry | null } = { entry: null }
	const tables: Omit<SampleTables, "timescale"> = {
		stts: null,
		stss: null,
		stsc: null,
		stsz: null,
		chunkOffsets: null,
		wideOffsets: false
	}

	await forEachChild(walk, minf, 4, async box => {
		if (box.type !== "stbl") {
			return
		}

		await forEachChild(walk, box, 5, async child => {
			if (locateTables) {
				if (child.type === "stts" || child.type === "stss" || child.type === "stsc" || child.type === "stsz") {
					tables[child.type] = range(child)
				} else if (child.type === "stco" || child.type === "co64") {
					tables.chunkOffsets = range(child)
					tables.wideOffsets = child.type === "co64"
				}
			}

			if (child.type !== "stsd") {
				return
			}

			// A full box and an entry count precede the first entry.
			if (child.dataStart + 16 > child.end) {
				throw new MalformedError("stsd without an entry")
			}

			const version = await readBytes(walk.source, child.dataStart, 1)
			const first = await boxHeader(walk, child.dataStart + 8, child.end, false)
			const size = first.end - first.start

			found.entry = {
				bytes: await readBytes(walk.source, first.start, Math.min(size, MAX_SAMPLE_ENTRY_BYTES)),
				stsdVersion: version[0] ?? 0,
				tables: locateTables ? tables : null
			}

			return locateTables
		})

		return false
	})

	return found.entry
}

// Nero `chpl`: version, flags, (version 1) four reserved bytes, a count, then per chapter a start in
// 100 ns units and a length-prefixed title.
function parseChpl(bytes: Uint8Array): ProbeChapter[] {
	const chapters: ProbeChapter[] = []
	let at = (bytes[0] ?? 0) === 1 ? 8 : 4
	const count = bytes[at] ?? 0

	at++

	for (let i = 0; i < count && at + 9 <= bytes.length && chapters.length < MAX_CHAPTERS; i++) {
		const start = uint64(bytes, at)
		const length = bytes[at + 8] ?? 0

		if (start === null || at + 9 + length > bytes.length) {
			break
		}

		chapters.push({ t: seconds(start / 1e7), title: utf8(bytes, at + 9, at + 9 + length) })
		at += 9 + length
	}

	return chapters.sort((a, b) => a.t - b.t)
}

const COVER_TYPES: Readonly<Record<number, string>> = { 13: "image/jpeg", 14: "image/png", 27: "image/bmp" }

// meta (a full box in ISO files, a plain one in QuickTime) → ilst → covr → its first `data` box.
async function walkMeta(walk: Walk, meta: Box, depth: number): Promise<void> {
	const head = await readBytes(walk.source, meta.dataStart, Math.min(8, meta.end - meta.dataStart))
	const children: Box = { ...meta, dataStart: ascii(head, 4, 8) === "hdlr" ? meta.dataStart : meta.dataStart + 4 }

	await forEachChild(walk, children, depth, async box => {
		if (box.type !== "ilst") {
			return
		}

		await forEachChild(walk, box, depth + 1, async item => {
			if (item.type !== "covr") {
				return
			}

			await forEachChild(walk, item, depth + 2, async data => {
				if (data.type !== "data" || data.end - data.dataStart <= 8) {
					return
				}

				const kind = await readBytes(walk.source, data.dataStart, 4)
				const offset = data.dataStart + 8
				let mime = COVER_TYPES[uint32(kind, 0) & 0xffffff] ?? null

				// A generic type: sniff the image's first bytes, but only when they cost no download.
				if (mime === null && walk.source.isCached(offset) && walk.source.isCached(Math.min(offset + 12, data.end) - 1)) {
					mime = sniffImageMime(await readBytes(walk.source, offset, Math.min(12, data.end - offset)))
				}

				walk.result.cover = { offset, size: data.end - offset, mime: mime ?? "image/*" }

				return false
			})

			return false
		})

		return false
	})
}

async function walkUdta(walk: Walk, udta: Box): Promise<void> {
	await forEachChild(walk, udta, 2, async box => {
		if (box.type === "chpl" && walk.tier === "full") {
			walk.result.chapters = parseChpl(await payload(walk, box, MAX_CHPL_BYTES))
		} else if (box.type === "meta" && walk.result.cover === null) {
			await walkMeta(walk, box, 3)
		}
	})
}

async function walkMoov(walk: Walk, moov: Box): Promise<void> {
	const { result } = walk
	let traks = 0

	walk.moovComplete = true

	await forEachChild(walk, moov, 1, async box => {
		if (box.type === "mvhd") {
			const bytes = await payload(walk, box, 112)
			const version = bytes[0] ?? 0

			walk.timescale = uint32(bytes, version === 1 ? 20 : 12)
			walk.nextTrackId = uint32(bytes, version === 1 ? 108 : 96)

			const duration = version === 1 ? uint64(bytes, 24) : uint32(bytes, 16)

			// All ones is QuickTime's "unknown"; zero is a fragmented file's empty movie.
			if (duration !== null && duration !== 0 && duration !== 0xffffffff && walk.timescale > 0) {
				result.durationSec = seconds(duration / walk.timescale)
			}
		} else if (box.type === "trak") {
			try {
				const track = await walkTrak(walk, box)

				if (track !== null) {
					result.tracks.push(track)
				}
			} catch (error) {
				if (error instanceof BlockReadError || error instanceof ReadBudgetError) {
					throw error
				}

				// The trak's own size is known, so the walk goes on with the next one.
				result.partial = true
			}

			traks++

			// Every track is seen, going by mvhd's next_track_ID: the rest (user data, often in the moov's
			// last block) is no card's business. The hint is not trusted when reading on costs nothing.
			if (walk.tier === "card" && walk.nextTrackId > 1 && traks >= walk.nextTrackId - 1 && !walk.source.isCached(box.end)) {
				walk.moovComplete = false

				return false
			}
		} else if (box.type === "mvex") {
			walk.fragmented = true

			await forEachChild(walk, box, 2, async child => {
				if (child.type === "mehd") {
					const bytes = await payload(walk, child, 12)

					walk.fragmentDuration = (bytes[0] ?? 0) === 1 ? uint64(bytes, 4) : uint32(bytes, 4)
				} else if (child.type === "trex" && child.end - child.dataStart >= 24) {
					const bytes = await payload(walk, child, 24)

					walk.fragmentDefaults.set(uint32(bytes, 4), { duration: uint32(bytes, 12), size: uint32(bytes, 16) })
				}
			})
		} else if ((box.type === "udta" || box.type === "meta") && walk.tier !== "card") {
			try {
				if (box.type === "udta") {
					await walkUdta(walk, box)
				} else if (result.cover === null) {
					await walkMeta(walk, box, 2)
				}
			} catch (error) {
				if (error instanceof BlockReadError || error instanceof ReadBudgetError) {
					throw error
				}

				// Broken user data costs the chapters or the cover, not the tracks.
				result.partial = true
			}
		}

		return true
	})
}

// A fragmented file's tail: the `mfra` the closing `mfro` locates, which says whether keyframes can be found
// without a scan, gives the duration when no `mehd` did (where its last fragment ends), and, for a walk asked
// for keyframes, the index itself. Only a tier that may grow its budget raises it; a card (and a keyframe
// walk, which runs under its caller's budget) spends what it has left. Out of budget, nothing is known;
// broken boxes leave the index absent.
async function walkFragmentTail(walk: Walk): Promise<void> {
	const { source, result, tier } = walk
	const needDuration = result.durationSec === null

	if (!needDuration && tier !== "full" && !walk.keyframes) {
		return
	}

	if (tier !== "card") {
		raiseBudget(source, Math.ceil(Math.min(MAX_MFRA_BYTES, source.size) / BLOCK_BYTES) + 2)
	}

	let access: FragmentIndex["access"] | null

	try {
		access = await readMfra(source)
	} catch (error) {
		if (error instanceof ReadBudgetError || error instanceof BlockReadError) {
			throw error
		}

		access = null
	}

	result.index = access === null || access.size === 0 ? "none" : "mfra"

	if (access === null || access.size === 0) {
		return
	}

	const index: FragmentIndex = { access, defaults: walk.fragmentDefaults, timescales: walk.timescales }

	if (walk.keyframes) {
		result.fragments = index
	}

	const last = needDuration ? lastMoof(access) : null

	if (last !== null) {
		const end = fragmentEnd(await readMoof(source, last), index)

		if (end !== null && end > 0) {
			result.durationSec = seconds(end)
		}
	}
}

// Top-level box headers to `moov`, wherever it is: a file written for streaming has it up front, one
// written straight from a camera after the whole `mdat`. Throws ReadBudgetError and MalformedError
// with whatever was found already in `result`.
export async function walkIsobmff(source: BlockSource, tier: ProbeTier, result: ParsedContainer, keyframes = false): Promise<void> {
	const walk: Walk = {
		source,
		tier,
		result,
		boxes: 0,
		fragmented: false,
		fragmentDuration: null,
		timescale: 0,
		timescales: new Map(),
		fragmentDefaults: new Map(),
		nextTrackId: 0,
		moovComplete: false,
		chapterTracks: new Set(),
		quickTime: true,
		cut: null,
		keyframes
	}
	let at = 0
	let sawFtyp = false

	for (let i = 0; at + 8 <= source.size; i++) {
		if (i >= MAX_TOP_LEVEL_BOXES) {
			throw new MalformedError("no moov among the top-level boxes")
		}

		const box = await boxHeader(walk, at, source.size, true)

		if (i === 0 && !LEADING_BOXES.has(box.type)) {
			throw new MalformedError("not an ISO BMFF file")
		}

		if (box.type === "ftyp") {
			// Major brand, minor version, then compatible brands.
			const brands = await readBytes(source, box.dataStart, Math.min(MAX_FTYP_BYTES, box.end - box.dataStart))
			const major = ascii(brands, 0, 4)
			let compatibleQuickTime = false

			sawFtyp = true

			for (let brand = 8; brand + 4 <= brands.length; brand += 4) {
				compatibleQuickTime ||= ascii(brands, brand, brand + 4) === "qt  "
			}

			walk.quickTime = major === "qt  " || compatibleQuickTime
			result.container = major === "qt  " ? "mov" : "mp4"
		}

		if (box.type === "moov") {
			if (!sawFtyp) {
				result.container = "mov"
			}

			// A tier that walks into the moov may read each block it spans, plus one either side.
			if (tier !== "card") {
				raiseBudget(source, Math.ceil((box.end - box.start) / BLOCK_BYTES) + 1)
			}

			try {
				await walkMoov(walk, box)
			} catch (error) {
				if (error instanceof BlockReadError) {
					throw error
				}

				// The tracks walked so far stand. Out of budget they are an incomplete list; past a broken
				// box after them they are every track the file declares in a readable form.
				result.partial = true
				walk.moovComplete = false
				walk.cut = error instanceof ReadBudgetError ? "budget" : "malformed"
			}

			result.tracks = result.tracks.filter(track => track.kind !== "subtitle" || !walk.chapterTracks.has(track.sub.id))

			result.tracksFound = walk.cut === null || (walk.cut === "malformed" && result.tracks.length > 0)

			if (result.durationSec === null && walk.fragmentDuration !== null && walk.timescale > 0) {
				result.durationSec = seconds(walk.fragmentDuration / walk.timescale)
			}

			if (walk.fragmented) {
				try {
					await walkFragmentTail(walk)
				} catch (error) {
					// Whatever the tail held stays unknown; the moov's tracks stand.
					if (!(error instanceof ReadBudgetError || error instanceof MalformedError)) {
						throw error
					}
				}
			} else if (walk.moovComplete) {
				result.index = "moov"
			}

			return
		}

		at = box.end
	}
}
