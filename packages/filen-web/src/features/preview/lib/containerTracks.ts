import type { BlockSource } from "@/lib/media/blockSource"

// The audio/video tracks a video file declares in its container header, read without decoding anything:
// MP4/MOV/M4V (ISO BMFF boxes) and Matroska/WebM (EBML elements). Only ever asked once a browser has
// shown it could not play part of a file, to name what it could not play.

export type TrackKind = "audio" | "video"

// Each codec this module names, with the query that asks a browser whether it can decode it. The
// profile in a video query is the most common one, so a browser that answers no cannot play the codec
// at all.
export const CODECS = {
	aac: { kind: "audio", label: "AAC", query: 'audio/mp4; codecs="mp4a.40.2"' },
	mp3: { kind: "audio", label: "MP3", query: "audio/mpeg" },
	ac3: { kind: "audio", label: "AC-3", query: 'audio/mp4; codecs="ac-3"' },
	eac3: { kind: "audio", label: "E-AC-3", query: 'audio/mp4; codecs="ec-3"' },
	dts: { kind: "audio", label: "DTS", query: 'audio/mp4; codecs="dtsc"' },
	truehd: { kind: "audio", label: "TrueHD", query: 'audio/mp4; codecs="mlpa"' },
	opus: { kind: "audio", label: "Opus", query: 'audio/webm; codecs="opus"' },
	vorbis: { kind: "audio", label: "Vorbis", query: 'audio/webm; codecs="vorbis"' },
	flac: { kind: "audio", label: "FLAC", query: "audio/flac" },
	alac: { kind: "audio", label: "ALAC", query: 'audio/mp4; codecs="alac"' },
	h264: { kind: "video", label: "H.264", query: 'video/mp4; codecs="avc1.42E01E"' },
	hevc: { kind: "video", label: "HEVC", query: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
	av1: { kind: "video", label: "AV1", query: 'video/mp4; codecs="av01.0.04M.08"' },
	vp9: { kind: "video", label: "VP9", query: 'video/webm; codecs="vp9"' },
	vp8: { kind: "video", label: "VP8", query: 'video/webm; codecs="vp8"' },
	theora: { kind: "video", label: "Theora", query: 'video/ogg; codecs="theora"' },
	mpeg4: { kind: "video", label: "MPEG-4 Part 2", query: 'video/mp4; codecs="mp4v.20.9"' }
} as const satisfies Record<string, { kind: TrackKind; label: string; query: string }>

export type CodecId = keyof typeof CODECS

// `codec` is null for a track whose format this module does not recognise.
export interface ContainerTrack {
	kind: TrackKind
	codec: CodecId | null
}

// Where the head walk starts: MP4 box headers and a Matroska file's leading elements sit here.
const HEAD_BYTES = 65_536
// A `moov` or Matroska `Tracks` larger than this is not worth the download just to name a codec.
const MAX_HEADER_BYTES = 4_194_304
// Top-level MP4 boxes visited looking for `moov`; past this the file is not shaped like one to read.
const MAX_TOP_LEVEL_BOXES = 64

async function readBytes(source: BlockSource, start: number, length: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(length)

	await source.read(bytes, start, length)

	return bytes
}

function uint32(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) * 0x1000000 + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0)
}

function uint16(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) + (bytes[at + 1] ?? 0)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	let text = ""

	for (let i = start; i < end; i++) {
		text += String.fromCharCode(bytes[i] ?? 0)
	}

	return text
}

// ── MP4 / MOV ────────────────────────────────────────────────────────────────

interface Box {
	type: string
	// The payload, after the header.
	start: number
	end: number
}

// A box header at `at` inside [at, limit): size 1 means a 64-bit size follows, 0 means "to the end".
function boxAt(bytes: Uint8Array, at: number, limit: number): Box | null {
	if (at + 8 > limit) {
		return null
	}

	let size = uint32(bytes, at)
	let header = 8

	if (size === 1) {
		if (at + 16 > limit) {
			return null
		}

		size = uint32(bytes, at + 8) * 0x100000000 + uint32(bytes, at + 12)
		header = 16
	} else if (size === 0) {
		size = limit - at
	}

	if (size < header || at + size > limit) {
		return null
	}

	return { type: ascii(bytes, at + 4, at + 8), start: at + header, end: at + size }
}

function childBox(bytes: Uint8Array, start: number, end: number, type: string): Box | null {
	let at = start

	while (at < end) {
		const box = boxAt(bytes, at, end)

		if (box === null) {
			return null
		}

		if (box.type === type) {
			return box
		}

		at = box.end
	}

	return null
}

function boxPath(bytes: Uint8Array, start: number, end: number, path: readonly string[]): Box | null {
	let box: Box | null = { type: "", start, end }

	for (const type of path) {
		box = box === null ? null : childBox(bytes, box.start, box.end, type)
	}

	return box
}

const MP4_SAMPLE_ENTRIES: Readonly<Record<string, CodecId>> = {
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
	".mp3": "mp3",
	avc1: "h264",
	avc3: "h264",
	hvc1: "hevc",
	hev1: "hevc",
	av01: "av1",
	vp09: "vp9",
	vp08: "vp8"
}

// ISO/IEC 14496-1 objectTypeIndication values an `esds` names.
const MP4_OBJECT_TYPES: Readonly<Record<number, CodecId>> = {
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

// esds: ES_Descriptor (tag 3) → DecoderConfigDescriptor (tag 4), whose first byte is the object type.
function esdsObjectType(bytes: Uint8Array, esds: Box): number | null {
	const es = descriptorAt(bytes, esds.start + 4, esds.end)

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

	const config = descriptorAt(bytes, at, es.end)

	return config?.tag === 4 ? (bytes[config.start] ?? null) : null
}

// An audio sample entry's child boxes follow a 28-byte body (36 more for a QuickTime version 2
// description, 16 for version 1); a visual one's follow 78 bytes. QuickTime nests `esds` inside `wave`.
function sampleEntryEsds(bytes: Uint8Array, entry: Box, kind: TrackKind): Box | null {
	let children = entry.start + 78

	if (kind === "audio") {
		const version = uint16(bytes, entry.start + 8)

		children = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
	}

	const esds = childBox(bytes, children, entry.end, "esds")

	if (esds !== null) {
		return esds
	}

	const wave = childBox(bytes, children, entry.end, "wave")

	return wave === null ? null : childBox(bytes, wave.start, wave.end, "esds")
}

function mp4Codec(bytes: Uint8Array, entry: Box, kind: TrackKind): CodecId | null {
	const direct = MP4_SAMPLE_ENTRIES[entry.type]

	if (direct !== undefined) {
		return direct
	}

	if (entry.type !== "mp4a" && entry.type !== "mp4v") {
		return null
	}

	const esds = sampleEntryEsds(bytes, entry, kind)
	const objectType = esds === null ? null : esdsObjectType(bytes, esds)

	return objectType === null ? null : (MP4_OBJECT_TYPES[objectType] ?? null)
}

// trak → mdia → hdlr names the track's kind; mdia → minf → stbl → stsd's first sample entry its codec.
function mp4Track(bytes: Uint8Array, trak: Box): ContainerTrack | null {
	const mdia = childBox(bytes, trak.start, trak.end, "mdia")
	const hdlr = mdia === null ? null : childBox(bytes, mdia.start, mdia.end, "hdlr")

	if (mdia === null || hdlr === null) {
		return null
	}

	const handler = ascii(bytes, hdlr.start + 8, hdlr.start + 12)
	const kind = handler === "soun" ? "audio" : handler === "vide" ? "video" : null

	if (kind === null) {
		return null
	}

	const stsd = boxPath(bytes, mdia.start, mdia.end, ["minf", "stbl", "stsd"])
	// A full box (4 bytes) and an entry count (4 bytes) precede the first entry.
	const entry = stsd === null ? null : boxAt(bytes, stsd.start + 8, stsd.end)

	return { kind, codec: entry === null ? null : mp4Codec(bytes, entry, kind) }
}

// The tracks of a whole `moov` box (header included).
function parseMp4Moov(moov: Uint8Array): ContainerTrack[] {
	const root = boxAt(moov, 0, moov.length)
	const tracks: ContainerTrack[] = []

	if (root?.type !== "moov") {
		return tracks
	}

	let at = root.start

	while (at < root.end) {
		const box = boxAt(moov, at, root.end)

		if (box === null) {
			break
		}

		if (box.type === "trak") {
			const track = mp4Track(moov, box)

			if (track !== null) {
				tracks.push(track)
			}
		}

		at = box.end
	}

	return tracks
}

// Box types a file may open with: `ftyp` in every MP4, the others in QuickTime files that predate it.
const MP4_LEADING_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"])

// Walks top-level box headers to `moov`, wherever it is: a file written for streaming has it up front,
// one written straight from a camera after the whole `mdat`. Each header is 8-16 bytes.
async function readMp4Tracks(source: BlockSource): Promise<ContainerTrack[] | null> {
	let at = 0

	for (let i = 0; i < MAX_TOP_LEVEL_BOXES && at + 8 <= source.size; i++) {
		const header = await readBytes(source, at, Math.min(16, source.size - at))
		const size32 = uint32(header, 0)
		const type = ascii(header, 4, 8)
		const size =
			size32 === 1
				? header.length < 16
					? 0
					: uint32(header, 8) * 0x100000000 + uint32(header, 12)
				: size32 === 0
					? source.size - at
					: size32

		if (size < 8 || at + size > source.size || (i === 0 && !MP4_LEADING_BOXES.has(type))) {
			return null
		}

		if (type === "moov") {
			return size > MAX_HEADER_BYTES ? null : parseMp4Moov(await readBytes(source, at, size))
		}

		at += size
	}

	return null
}

// ── Matroska / WebM ──────────────────────────────────────────────────────────

const EBML_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const SEEK_HEAD_ID = 0x114d9b74
const SEEK_ID = 0x4dbb
const SEEK_ID_ID = 0x53ab
const SEEK_POSITION_ID = 0x53ac
const TRACKS_ID = 0x1654ae6b
const TRACK_ENTRY_ID = 0xae
const TRACK_TYPE_ID = 0x83
const CODEC_ID_ID = 0x86
const CLUSTER_ID = 0x1f43b675

interface Element {
	id: number
	// The payload's offsets; `size` is null for an element of unknown size (a live-written Segment).
	start: number
	size: number | null
}

// A variable-length integer's byte count: the position of its first set bit.
function vintLength(first: number): number {
	for (let i = 0; i < 8; i++) {
		if ((first & (0x80 >> i)) !== 0) {
			return i + 1
		}
	}

	return 0
}

// An element header at `at`: an ID (marker bit kept) and a size (marker bit dropped; all ones = unknown).
function elementAt(bytes: Uint8Array, at: number): Element | null {
	const idLength = vintLength(bytes[at] ?? 0)

	if (idLength === 0 || idLength > 4 || at + idLength >= bytes.length) {
		return null
	}

	let id = 0

	for (let i = 0; i < idLength; i++) {
		id = id * 256 + (bytes[at + i] ?? 0)
	}

	const sizeAt = at + idLength
	const sizeLength = vintLength(bytes[sizeAt] ?? 0)

	if (sizeLength === 0 || sizeAt + sizeLength > bytes.length) {
		return null
	}

	let size = (bytes[sizeAt] ?? 0) & (0xff >> sizeLength)
	let unknown = size === 0xff >> sizeLength

	for (let i = 1; i < sizeLength; i++) {
		const byte = bytes[sizeAt + i] ?? 0

		size = size * 256 + byte
		unknown &&= byte === 0xff
	}

	return { id, start: sizeAt + sizeLength, size: unknown ? null : size }
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
	let value = 0

	for (let i = start; i < end; i++) {
		value = value * 256 + (bytes[i] ?? 0)
	}

	return value
}

// The children of [start, end) that are complete within it.
function elements(bytes: Uint8Array, start: number, end: number): Element[] {
	const children: Element[] = []
	let at = start

	while (at < end) {
		const element = elementAt(bytes, at)
		const size = element?.size ?? null

		if (element === null || size === null || element.start + size > end) {
			break
		}

		children.push(element)
		at = element.start + size
	}

	return children
}

const MATROSKA_CODECS: readonly (readonly [string, CodecId])[] = [
	["A_AAC", "aac"],
	["A_AC3", "ac3"],
	["A_EAC3", "eac3"],
	["A_DTS", "dts"],
	["A_TRUEHD", "truehd"],
	["A_OPUS", "opus"],
	["A_VORBIS", "vorbis"],
	["A_FLAC", "flac"],
	["A_MPEG/L3", "mp3"],
	["A_ALAC", "alac"],
	["V_MPEG4/ISO/AVC", "h264"],
	["V_MPEGH/ISO/HEVC", "hevc"],
	["V_AV1", "av1"],
	["V_VP9", "vp9"],
	["V_VP8", "vp8"],
	["V_THEORA", "theora"],
	["V_MPEG4/ISO/ASP", "mpeg4"],
	["V_MPEG4/ISO/SP", "mpeg4"],
	["V_MPEG4/ISO/AP", "mpeg4"]
]

// A CodecID matches its exact name or a sub-variant of it (A_AAC/MPEG4/LC, A_DTS/EXPRESS).
function matroskaCodec(codecId: string): CodecId | null {
	for (const [name, codec] of MATROSKA_CODECS) {
		if (codecId === name || codecId.startsWith(`${name}/`)) {
			return codec
		}
	}

	return null
}

// The tracks of a Tracks element's payload.
export function parseMatroskaTracks(payload: Uint8Array): ContainerTrack[] {
	const tracks: ContainerTrack[] = []

	for (const entry of elements(payload, 0, payload.length)) {
		if (entry.id !== TRACK_ENTRY_ID || entry.size === null) {
			continue
		}

		let type = 0
		let codecId = ""

		for (const field of elements(payload, entry.start, entry.start + entry.size)) {
			const end = field.start + (field.size ?? 0)

			if (field.id === TRACK_TYPE_ID) {
				type = readUint(payload, field.start, end)
			} else if (field.id === CODEC_ID_ID) {
				codecId = ascii(payload, field.start, end).replace(/\0+$/, "")
			}
		}

		// TrackType 1 is video, 2 audio; subtitles and the rest are not played tracks.
		if (type === 1 || type === 2) {
			tracks.push({ kind: type === 1 ? "video" : "audio", codec: matroskaCodec(codecId) })
		}
	}

	return tracks
}

// A SeekHead entry pointing at Tracks, as an offset into the Segment's payload.
function seekToTracks(head: Uint8Array, seekHead: Element): number | null {
	for (const seek of elements(head, seekHead.start, seekHead.start + (seekHead.size ?? 0))) {
		if (seek.id !== SEEK_ID || seek.size === null) {
			continue
		}

		let id = 0
		let position: number | null = null

		for (const field of elements(head, seek.start, seek.start + seek.size)) {
			const end = field.start + (field.size ?? 0)

			if (field.id === SEEK_ID_ID) {
				id = readUint(head, field.start, end)
			} else if (field.id === SEEK_POSITION_ID) {
				position = readUint(head, field.start, end)
			}
		}

		if (id === TRACKS_ID && position !== null) {
			return position
		}
	}

	return null
}

// EBML header, then the Segment; its first children (SeekHead, Info, Tracks) normally fit in the head.
// Tracks found there is read whole; otherwise the SeekHead says where it is.
async function readMatroskaTracks(source: BlockSource, head: Uint8Array): Promise<ContainerTrack[] | null> {
	const ebml = elementAt(head, 0)
	const ebmlSize = ebml?.size ?? null

	if (ebml === null || ebmlSize === null) {
		return null
	}

	const segment = elementAt(head, ebml.start + ebmlSize)

	if (segment?.id !== SEGMENT_ID) {
		return null
	}

	let tracksAt: number | null = null
	let seeked: number | null = null
	let at = segment.start

	while (tracksAt === null) {
		const element = elementAt(head, at)

		if (element === null || element.id === CLUSTER_ID) {
			break
		}

		if (element.id === TRACKS_ID) {
			tracksAt = at
		} else if (element.size === null) {
			break
		} else {
			if (element.id === SEEK_HEAD_ID && element.start + element.size <= head.length) {
				const position = seekToTracks(head, element)

				seeked = position === null ? null : segment.start + position
			}

			at = element.start + element.size
		}
	}

	tracksAt ??= seeked

	if (tracksAt === null || tracksAt >= source.size) {
		return null
	}

	const header = await readBytes(source, tracksAt, Math.min(12, source.size - tracksAt))
	const tracks = elementAt(header, 0)

	if (
		tracks?.id !== TRACKS_ID ||
		tracks.size === null ||
		tracks.size > MAX_HEADER_BYTES ||
		tracksAt + tracks.start + tracks.size > source.size
	) {
		return null
	}

	return parseMatroskaTracks(await readBytes(source, tracksAt + tracks.start, tracks.size))
}

// ── Entry point ──────────────────────────────────────────────────────────────

// The file's tracks, or null when it is neither container, is malformed, or puts its header out of
// reach. Reads throw like the source's own reads do.
export async function readContainerTracks(source: BlockSource): Promise<ContainerTrack[] | null> {
	if (source.size < 8) {
		return null
	}

	const head = await readBytes(source, 0, Math.min(source.size, HEAD_BYTES))

	if (uint32(head, 0) === EBML_ID) {
		return readMatroskaTracks(source, head)
	}

	return readMp4Tracks(source)
}

// The tracks of `kinds` whose codec the browser says it cannot decode; a track of an unrecognised
// codec is never claimed, since nothing can be asked about it.
export function unplayableTracks(
	tracks: readonly ContainerTrack[],
	kinds: readonly TrackKind[],
	canPlay: (query: string) => boolean
): CodecId[] {
	const unplayable: CodecId[] = []

	for (const track of tracks) {
		if (
			track.codec !== null &&
			kinds.includes(track.kind) &&
			!canPlay(CODECS[track.codec].query) &&
			!unplayable.includes(track.codec)
		) {
			unplayable.push(track.codec)
		}
	}

	return unplayable
}

// Asks both decoder surfaces: MediaSource answers for what an element can stream, canPlayType for what
// it plays from a plain src. Either saying yes means the codec is not the problem.
export function browserCanPlay(media: HTMLMediaElement): (query: string) => boolean {
	return query => (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(query)) || media.canPlayType(query) !== ""
}
