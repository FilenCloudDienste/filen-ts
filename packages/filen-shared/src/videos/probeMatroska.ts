import {
	av1CodecString,
	avcCodecString,
	dolbyVisionCodecString,
	dtsCodecString,
	hevcCodecString,
	matroskaAacCodecString,
	parseAudioSpecificConfig,
	parseAv1C,
	parseAvcC,
	parseHvcC,
	parseMatroskaVp9Private,
	simpleAudioCodecString,
	vp9CodecString,
	vp9LevelForSize,
	type ColourInfo
} from "./codecString"
import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import {
	MalformedError,
	UnsupportedContainerError,
	fourcc as fourccOf,
	parseDolbyVision,
	raiseBudget,
	readBytes,
	seconds,
	transferKind,
	utf8,
	type DolbyVisionConfig
} from "./probeBytes"
import {
	MAX_EBML_CHILDREN,
	MAX_EBML_STRING_BYTES,
	ebmlBinary,
	ebmlChildren,
	ebmlFloat,
	ebmlString,
	ebmlUint,
	inflateCapped,
	parseElementHeader,
	type EbmlContext,
	type EbmlElement
} from "./probeEbml"
import { MAX_CHAPTERS, type MediaCodec, type ParsedContainer, type ParsedTrack, type ProbeChapter, type ProbeTier } from "./probeTypes"
import { EBML_ID } from "./transportStreamHead"

// Matroska/WebM: the Segment's top-level elements are walked by header; the few a probe needs (SeekHead,
// Info, Tracks, Chapters) are read whole under size caps, and the rest (Clusters, Cues, the payloads of
// Attachments) are skipped by size or reached through the SeekHead, never read.

const DOC_TYPE_ID = 0x4282
const SEGMENT_ID = 0x18538067
const SEEK_HEAD_ID = 0x114d9b74
const SEEK_ID = 0x4dbb
const SEEK_ID_ID = 0x53ab
const SEEK_POSITION_ID = 0x53ac
const INFO_ID = 0x1549a966
const TIMESTAMP_SCALE_ID = 0x2ad7b1
const DURATION_ID = 0x4489
const TRACKS_ID = 0x1654ae6b
const TRACK_ENTRY_ID = 0xae
const CHAPTERS_ID = 0x1043a770
const ATTACHMENTS_ID = 0x1941a469
const ATTACHED_FILE_ID = 0x61a7
const FILE_NAME_ID = 0x466e
const FILE_MEDIA_TYPE_ID = 0x4660
const FILE_DATA_ID = 0x465c
const CUES_ID = 0x1c53bb6b
const TAGS_ID = 0x1254c367
const CLUSTER_ID = 0x1f43b675

const TOP_LEVEL_IDS = new Set([SEEK_HEAD_ID, INFO_ID, TRACKS_ID, CHAPTERS_ID, ATTACHMENTS_ID, CUES_ID, TAGS_ID, CLUSTER_ID])

const MAX_EBML_HEADER_BYTES = 4096
const MAX_SEEK_HEAD_BYTES = 65_536
const MAX_INFO_BYTES = 1_048_576
const MAX_TRACKS_BYTES = 1_048_576
const MAX_CHAPTERS_BYTES = 1_048_576
const MAX_INFLATED_BYTES = 1_048_576
const MAX_CHAPTER_ATOMS = 4096
// Attachment headers visited in blocks not already fetched while looking for the covers; fonts commonly
// come first, each one its own block away.
const MAX_COVER_HOPS = 4

interface Walk {
	source: BlockSource
	tier: ProbeTier
	result: ParsedContainer
	context: EbmlContext
	segmentStart: number
	segmentEnd: number
	seeks: Map<number, number[]>
	hasSeekHead: boolean
	visited: Set<number>
	visitedSeekHeads: Set<number>
	resyncedBlocks: Set<number>
	elements: number
	// Capture what finding keyframes takes (walkContainer's `keyframes`).
	keyframes: boolean
	timestampScale: number
	cuesAt: number | null
}

// The elements each tier reads; Info and Tracks are never skipped on the SeekHead's say-so.
function needs(tier: ProbeTier): number[] {
	switch (tier) {
		case "card":
			return [INFO_ID, TRACKS_ID]
		case "full":
			return [INFO_ID, TRACKS_ID, CHAPTERS_ID, ATTACHMENTS_ID]
		case "cover":
			return [INFO_ID, TRACKS_ID, ATTACHMENTS_ID]
	}
}

const MANDATORY = new Set([INFO_ID, TRACKS_ID])

// The element header at `at`, read from the file. Twelve bytes hold any valid header, but most are a
// few bytes long: the read stops at the block's end and only goes on when the header does.
async function headerAt(walk: Walk, at: number, limit: number): Promise<EbmlElement | null> {
	const full = Math.min(12, limit - at)
	const inBlock = Math.min(full, (Math.floor(at / BLOCK_BYTES) + 1) * BLOCK_BYTES - at)
	let element = parseElementHeader(await readBytes(walk.source, at, inBlock), 0)

	if (element === "short" && inBlock < full) {
		element = parseElementHeader(await readBytes(walk.source, at, full), 0)
	}

	if (typeof element === "string") {
		return null
	}

	return { id: element.id, start: at, dataStart: at + element.dataStart, end: element.end === null ? null : at + element.end }
}

async function readPayload(walk: Walk, element: EbmlElement, cap: number): Promise<Uint8Array | null> {
	if (element.end === null || element.end - element.dataStart > cap || element.end > walk.source.size) {
		walk.context.malformed = true

		return null
	}

	return readBytes(walk.source, element.dataStart, element.end - element.dataStart)
}

// ── SeekHead and Info ───────────────────────────────────────────────────────

function parseSeekHead(walk: Walk, bytes: Uint8Array): void {
	walk.hasSeekHead = true

	for (const seek of ebmlChildren(bytes, 0, bytes.length, 2, walk.context)) {
		if (seek.id !== SEEK_ID || seek.end === null) {
			continue
		}

		let id: number | null = null
		let position: number | null = null

		for (const field of ebmlChildren(bytes, seek.dataStart, seek.end, 3, walk.context)) {
			if (field.id === SEEK_ID_ID) {
				id = ebmlUint(bytes, field)
			} else if (field.id === SEEK_POSITION_ID) {
				position = ebmlUint(bytes, field)
			}
		}

		if (id !== null && position !== null && walk.segmentStart + position < walk.segmentEnd) {
			const positions = walk.seeks.get(id) ?? []

			positions.push(walk.segmentStart + position)
			walk.seeks.set(id, positions)
		}
	}
}

function parseInfo(walk: Walk, bytes: Uint8Array): void {
	let scale = 1_000_000
	let duration: number | null = null

	for (const field of ebmlChildren(bytes, 0, bytes.length, 2, walk.context)) {
		if (field.id === TIMESTAMP_SCALE_ID) {
			scale = ebmlUint(bytes, field, 1_000_000) ?? scale
		} else if (field.id === DURATION_ID) {
			duration = ebmlFloat(bytes, field)
		}
	}

	walk.timestampScale = scale

	if (duration !== null && duration > 0 && scale > 0) {
		walk.result.durationSec = seconds((duration * scale) / 1e9)
	}
}

// ── Tracks ──────────────────────────────────────────────────────────────────

interface RawTrack {
	number: number
	type: number
	enabled: boolean
	isDefault: boolean
	forced: boolean
	hearingImpaired: boolean
	commentary: boolean
	name: string | null
	language: string | null
	bcp47: string | null
	codecId: string
	codecPrivate: Uint8Array | null
	// Set when CodecPrivate is compressed by a ContentEncoding this reader cannot undo.
	privateUnreadable: boolean
	// A ContentEncoding applies to the frames themselves.
	encodedFrames: boolean
	compression: { algorithm: number; settings: Uint8Array } | null
	// How the frames are compressed (zlib or header stripping); "unsupported" for anything else.
	frameCompression: { algorithm: number; settings: Uint8Array } | "unsupported" | null
	pixelWidth: number
	pixelHeight: number
	displayWidth: number | null
	displayHeight: number | null
	displayUnit: number
	bitsPerChannel: number | null
	colour: { primaries: number | null; transfer: number | null; matrix: number | null; range: number | null } | null
	roll: number | null
	samplingFrequency: number | null
	outputSamplingFrequency: number | null
	channels: number | null
	dolbyVision: DolbyVisionConfig | null
}

// Fourccs of the Dolby Vision configuration records a BlockAdditionMapping may carry.
const DOLBY_VISION_TYPES = new Set(["dvcC", "dvvC", "dvwC"])

function parseVideo(bytes: Uint8Array, video: EbmlElement, raw: RawTrack, context: EbmlContext): void {
	for (const field of ebmlChildren(bytes, video.dataStart, video.end ?? video.dataStart, 4, context)) {
		switch (field.id) {
			case 0xb0:
				raw.pixelWidth = ebmlUint(bytes, field) ?? 0
				break
			case 0xba:
				raw.pixelHeight = ebmlUint(bytes, field) ?? 0
				break
			case 0x54b0:
				raw.displayWidth = ebmlUint(bytes, field)
				break
			case 0x54ba:
				raw.displayHeight = ebmlUint(bytes, field)
				break
			case 0x54b2:
				raw.displayUnit = ebmlUint(bytes, field) ?? 0
				break
			case 0x55b0: {
				const colour: NonNullable<RawTrack["colour"]> = { primaries: null, transfer: null, matrix: null, range: null }

				for (const item of ebmlChildren(bytes, field.dataStart, field.end ?? field.dataStart, 5, context)) {
					if (item.id === 0x55b2) {
						raw.bitsPerChannel = ebmlUint(bytes, item)
					} else if (item.id === 0x55ba) {
						colour.transfer = ebmlUint(bytes, item, 2)
					} else if (item.id === 0x55bb) {
						colour.primaries = ebmlUint(bytes, item, 2)
					} else if (item.id === 0x55b1) {
						colour.matrix = ebmlUint(bytes, item, 2)
					} else if (item.id === 0x55b9) {
						colour.range = ebmlUint(bytes, item)
					}
				}

				raw.colour = colour
				break
			}
			case 0x7670:
				for (const item of ebmlChildren(bytes, field.dataStart, field.end ?? field.dataStart, 5, context)) {
					if (item.id === 0x7675) {
						raw.roll = ebmlFloat(bytes, item)
					}
				}
				break
		}
	}
}

function parseAudio(bytes: Uint8Array, audio: EbmlElement, raw: RawTrack, context: EbmlContext): void {
	for (const field of ebmlChildren(bytes, audio.dataStart, audio.end ?? audio.dataStart, 4, context)) {
		if (field.id === 0xb5) {
			raw.samplingFrequency = ebmlFloat(bytes, field, 8000)
		} else if (field.id === 0x78b5) {
			// Empty means "same as SamplingFrequency", its declared default.
			const output = ebmlFloat(bytes, field)

			raw.outputSamplingFrequency = output === 0 ? null : output
		} else if (field.id === 0x9f) {
			raw.channels = ebmlUint(bytes, field, 1)
		}
	}
}

// ContentEncodings: only a compression whose scope covers CodecPrivate (scope bit 2) changes what this
// reader sees; zlib and header stripping are undone, anything else leaves the private data unreadable.
function parseEncodings(bytes: Uint8Array, encodings: EbmlElement, raw: RawTrack, context: EbmlContext): void {
	for (const encoding of ebmlChildren(bytes, encodings.dataStart, encodings.end ?? encodings.dataStart, 4, context)) {
		if (encoding.id !== 0x6240) {
			continue
		}

		let scope = 1
		let type = 0
		let algorithm = 0
		let settings: Uint8Array = new Uint8Array(0)

		for (const field of ebmlChildren(bytes, encoding.dataStart, encoding.end ?? encoding.dataStart, 5, context)) {
			if (field.id === 0x5032) {
				scope = ebmlUint(bytes, field, 1) ?? scope
			} else if (field.id === 0x5033) {
				type = ebmlUint(bytes, field) ?? type
			} else if (field.id === 0x5034) {
				for (const item of ebmlChildren(bytes, field.dataStart, field.end ?? field.dataStart, 6, context)) {
					if (item.id === 0x4254) {
						algorithm = ebmlUint(bytes, item) ?? algorithm
					} else if (item.id === 0x4255) {
						settings = ebmlBinary(bytes, item)
					}
				}
			}
		}

		if ((scope & 1) !== 0) {
			raw.encodedFrames = true
			raw.frameCompression =
				type === 0 && raw.frameCompression === null && (algorithm === 0 || algorithm === 3)
					? { algorithm, settings }
					: "unsupported"
		}

		if ((scope & 2) === 0) {
			continue
		}

		if (type !== 0 || raw.compression !== null || (algorithm !== 0 && algorithm !== 3)) {
			raw.privateUnreadable = true
		} else {
			raw.compression = { algorithm, settings }
		}
	}
}

function parseTrackEntry(bytes: Uint8Array, entry: EbmlElement, context: EbmlContext): RawTrack {
	const raw: RawTrack = {
		number: 0,
		type: 0,
		enabled: true,
		isDefault: true,
		forced: false,
		hearingImpaired: false,
		commentary: false,
		name: null,
		language: null,
		bcp47: null,
		codecId: "",
		codecPrivate: null,
		privateUnreadable: false,
		encodedFrames: false,
		compression: null,
		frameCompression: null,
		pixelWidth: 0,
		pixelHeight: 0,
		displayWidth: null,
		displayHeight: null,
		displayUnit: 0,
		bitsPerChannel: null,
		colour: null,
		roll: null,
		samplingFrequency: null,
		outputSamplingFrequency: null,
		channels: null,
		dolbyVision: null
	}

	for (const field of ebmlChildren(bytes, entry.dataStart, entry.end ?? entry.dataStart, 3, context)) {
		switch (field.id) {
			case 0xd7:
				raw.number = ebmlUint(bytes, field) ?? 0
				break
			case 0x83:
				raw.type = ebmlUint(bytes, field) ?? 0
				break
			case 0xb9:
				raw.enabled = ebmlUint(bytes, field, 1) !== 0
				break
			case 0x88:
				raw.isDefault = ebmlUint(bytes, field, 1) !== 0
				break
			case 0x55aa:
				raw.forced = ebmlUint(bytes, field) === 1
				break
			case 0x55ab:
				raw.hearingImpaired = ebmlUint(bytes, field) === 1
				break
			case 0x55af:
				raw.commentary = ebmlUint(bytes, field) === 1
				break
			case 0x536e:
				raw.name = ebmlString(bytes, field)
				break
			case 0x22b59c:
				raw.language = ebmlString(bytes, field)
				break
			case 0x22b59d:
				raw.bcp47 = ebmlString(bytes, field)
				break
			case 0x86:
				raw.codecId = ebmlString(bytes, field) ?? ""
				break
			case 0x63a2:
				raw.codecPrivate = ebmlBinary(bytes, field)
				break
			case 0xe0:
				parseVideo(bytes, field, raw, context)
				break
			case 0xe1:
				parseAudio(bytes, field, raw, context)
				break
			case 0x6d80:
				parseEncodings(bytes, field, raw, context)
				break
			case 0x41e4: {
				let type: number | null = null
				let extra: Uint8Array | null = null

				for (const item of ebmlChildren(bytes, field.dataStart, field.end ?? field.dataStart, 4, context)) {
					if (item.id === 0x41e7) {
						type = ebmlUint(bytes, item)
					} else if (item.id === 0x41ed) {
						extra = ebmlBinary(bytes, item)
					}
				}

				if (type !== null && extra !== null && DOLBY_VISION_TYPES.has(fourccOf(type))) {
					raw.dolbyVision = parseDolbyVision(extra)
				}
				break
			}
		}
	}

	return raw
}

// Codecs whose CodecPrivate the probe reads; nothing else is ever decompressed.
const PRIVATE_CODECS = new Set<MediaCodec>(["aac", "h264", "hevc", "av1", "vp9", "alac"])

// Bytes inflated per walk across all tracks, so many small compressed privates cannot add up.
const MAX_INFLATED_PER_WALK = 2 * MAX_INFLATED_BYTES

interface InflateBudget {
	remaining: number
}

async function codecPrivateOf(raw: RawTrack, budget: InflateBudget): Promise<Uint8Array | null> {
	const { codecPrivate, compression } = raw
	const codec = matroskaCodec(raw.codecId)

	if (codecPrivate === null || raw.privateUnreadable || codec === null || !PRIVATE_CODECS.has(codec)) {
		return null
	}

	if (compression === null) {
		return codecPrivate
	}

	if (compression.algorithm === 3) {
		const out = new Uint8Array(compression.settings.length + codecPrivate.length)

		out.set(compression.settings)
		out.set(codecPrivate, compression.settings.length)

		return out
	}

	const inflated = await inflateCapped(codecPrivate, Math.min(MAX_INFLATED_BYTES, budget.remaining))

	budget.remaining -= inflated?.length ?? budget.remaining

	return inflated
}

const MATROSKA_CODECS: readonly (readonly [string, MediaCodec])[] = [
	["A_AAC", "aac"],
	["A_AC3", "ac3"],
	["A_EAC3", "eac3"],
	["A_DTS", "dts"],
	["A_TRUEHD", "truehd"],
	["A_OPUS", "opus"],
	["A_VORBIS", "vorbis"],
	["A_FLAC", "flac"],
	["A_MPEG/L3", "mp3"],
	["A_MPEG/L2", "mp2"],
	["A_MPEG/L1", "mp1"],
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
function matroskaCodec(codecId: string): MediaCodec | null {
	for (const [name, codec] of MATROSKA_CODECS) {
		if (codecId === name || codecId.startsWith(`${name}/`)) {
			return codec
		}
	}

	return null
}

// What a remux to MP4 would write as the sample entry.
const REMUX_FOURCCS: Partial<Record<MediaCodec, string>> = { h264: "avc1", hevc: "hvc1", av1: "av01", vp9: "vp09", vp8: "vp08" }

// LanguageBCP47 first, then the legacy Language, whose spec default is "eng" when the element is
// absent (mkvmerge omits it for English). "und" is reported as no language.
function languageOf(raw: RawTrack): string | null {
	const language = raw.bcp47 ?? raw.language ?? "eng"

	return language === "und" ? null : language
}

function colourInfo(raw: RawTrack): ColourInfo | null {
	const { colour } = raw

	if (colour === null) {
		return null
	}

	return {
		primaries: colour.primaries ?? 2,
		transfer: colour.transfer ?? 2,
		matrix: colour.matrix ?? 2,
		fullRange: colour.range === 2
	}
}

function videoTrack(raw: RawTrack, codecPrivate: Uint8Array | null): ParsedTrack {
	const codec = matroskaCodec(raw.codecId)
	const colour = colourInfo(raw)
	let codecString: string | null = null
	let configBitDepth: number | null = null

	if (codec === "h264" && codecPrivate !== null) {
		codecString = avcCodecString({ fourcc: "avc1", avcC: codecPrivate })
		configBitDepth = parseAvcC(codecPrivate)?.bitDepth ?? null
	} else if (codec === "hevc" && codecPrivate !== null) {
		codecString = hevcCodecString({ fourcc: "hvc1", hvcC: codecPrivate })
		configBitDepth = parseHvcC(codecPrivate)?.bitDepth ?? null
	} else if (codec === "av1" && codecPrivate !== null) {
		codecString = av1CodecString({ av1C: codecPrivate, colour })
		configBitDepth = parseAv1C(codecPrivate)?.bitDepth ?? null
	} else if (codec === "vp9") {
		// CodecPrivate is optional for VP9; an 8-bit 4:2:0 stream at the level its size needs is the norm.
		const features = codecPrivate === null ? {} : parseMatroskaVp9Private(codecPrivate)
		const bitDepth = features.bitDepth ?? raw.bitsPerChannel ?? 8

		configBitDepth = features.bitDepth ?? null
		codecString = vp9CodecString({
			profile: features.profile ?? (bitDepth > 8 ? 2 : 0),
			level: features.level ?? vp9LevelForSize({ width: raw.pixelWidth, height: raw.pixelHeight }),
			bitDepth,
			chromaSubsampling: features.chromaSubsampling ?? 1,
			colour
		})
	} else if (codec === "vp8") {
		codecString = "vp8"
		configBitDepth = 8
	}

	const fourcc = (codec === null ? undefined : REMUX_FOURCCS[codec]) ?? raw.codecId
	const dv = raw.dolbyVision

	// Without a compatible base layer only a Dolby Vision decoder can show the picture.
	if (dv !== null && dv.compat === 0) {
		codecString = dolbyVisionCodecString({ fourcc, profile: dv.profile, level: dv.level }) ?? codecString
	}

	const { pixelWidth, pixelHeight, displayWidth, displayHeight } = raw
	const par =
		raw.displayUnit === 0 && displayWidth !== null && displayHeight !== null && displayHeight > 0 && pixelWidth > 0 && pixelHeight > 0
			? Math.round(((displayWidth * pixelHeight) / (displayHeight * pixelWidth)) * 10_000) / 10_000
			: 1
	// ProjectionPoseRoll turns the picture counter-clockwise.
	const rotation = raw.roll === null ? 0 : (((Math.round(-raw.roll / 90) * 90) % 360) + 360) % 360

	return {
		kind: "video",
		enabled: raw.enabled,
		video: {
			codec,
			fourcc,
			codecString,
			w: pixelWidth,
			h: pixelHeight,
			par,
			rotation,
			bitDepth: raw.bitsPerChannel !== null && raw.bitsPerChannel > 0 ? raw.bitsPerChannel : configBitDepth,
			transfer: transferKind(raw.colour?.transfer ?? null),
			...(dv === null ? {} : { dv: { profile: dv.profile, compat: dv.compat } })
		}
	}
}

function audioCodecString(codec: MediaCodec | null, raw: RawTrack, codecPrivate: Uint8Array | null): string | null {
	switch (codec) {
		case "aac":
			return matroskaAacCodecString({ codecId: raw.codecId, codecPrivate })
		case "dts":
			return dtsCodecString(raw.codecId)
		case "mp3":
		case "opus":
		case "flac":
		case "vorbis":
		case "ac3":
		case "eac3":
		case "truehd":
		case "alac":
			return simpleAudioCodecString(codec)
		default:
			return null
	}
}

function audioTrack(raw: RawTrack, codecPrivate: Uint8Array | null): ParsedTrack {
	const codec = matroskaCodec(raw.codecId)
	const config = codec === "aac" && codecPrivate !== null ? parseAudioSpecificConfig(codecPrivate) : null
	// Opus always decodes at 48 kHz, whatever its track states.
	const rate = codec === "opus" ? 48000 : (raw.outputSamplingFrequency ?? raw.samplingFrequency ?? config?.sampleRate ?? 8000)

	return {
		kind: "audio",
		enabled: raw.enabled,
		...(codec === "alac" ? { config: codecPrivate } : {}),
		audio: {
			id: raw.number,
			codec,
			codecString: audioCodecString(codec, raw, codecPrivate),
			ch: raw.channels ?? config?.channels ?? 1,
			rate: Math.round(rate),
			lang: languageOf(raw),
			name: raw.name,
			def: raw.isDefault,
			forced: raw.forced,
			commentary: raw.commentary
		}
	}
}

// The CodecPrivate a decoder is configured with, for the codecs that have one (VP8/VP9 have none).
const DESCRIBED_CODECS = new Set<MediaCodec>(["h264", "hevc", "av1"])

// The tracks of a Tracks element's payload, in file order. TrackType 1 is video, 2 audio, 17 subtitles.
// `keyframes` adds what decoding a picture track's keyframes takes.
async function parseTracksPayload(bytes: Uint8Array, context: EbmlContext, keyframes: boolean): Promise<ParsedTrack[]> {
	const tracks: ParsedTrack[] = []
	const budget: InflateBudget = { remaining: MAX_INFLATED_PER_WALK }

	for (const entry of ebmlChildren(bytes, 0, bytes.length, 2, context)) {
		if (entry.id !== TRACK_ENTRY_ID) {
			continue
		}

		const raw = parseTrackEntry(bytes, entry, context)

		// FlagEnabled 0 marks a track no player may use.
		if (!raw.enabled) {
			continue
		}

		if (raw.type === 1) {
			const codecPrivate = await codecPrivateOf(raw, budget)
			const track = videoTrack(raw, codecPrivate)
			const codec = matroskaCodec(raw.codecId)

			if (keyframes && track.kind === "video") {
				track.decode = {
					track: raw.number,
					description: codec !== null && DESCRIBED_CODECS.has(codec) ? codecPrivate : null,
					encodedFrames: raw.encodedFrames,
					tables: null
				}
			}

			tracks.push(track)
		} else if (raw.type === 2) {
			tracks.push(audioTrack(raw, await codecPrivateOf(raw, budget)))
		} else if (raw.type === 17) {
			tracks.push({
				kind: "subtitle",
				enabled: raw.enabled,
				frames: raw.frameCompression,
				sub: {
					id: raw.number,
					codecId: raw.codecId,
					lang: languageOf(raw),
					name: raw.name,
					def: raw.isDefault,
					forced: raw.forced,
					hi: raw.hearingImpaired
				}
			})
		}
	}

	return tracks
}

// ── Chapters ────────────────────────────────────────────────────────────────

const EDITION_ENTRY_ID = 0x45b9
const EDITION_FLAG_HIDDEN_ID = 0x45bd
const EDITION_FLAG_DEFAULT_ID = 0x45db
const CHAPTER_ATOM_ID = 0xb6

interface ChapterCount {
	atoms: number
}

interface ParsedAtom {
	chapter: ProbeChapter
	// A hidden or disabled chapter is not shown; one naming another segment plays content this file lacks.
	shown: boolean
}

function parseAtom(bytes: Uint8Array, atom: EbmlElement, context: EbmlContext): ParsedAtom | null {
	let start: number | null = null
	let end: number | null = null
	let hidden = false
	let enabled = true
	let linked = false
	let skipType: number | null = null
	let title: string | null = null

	for (const field of ebmlChildren(bytes, atom.dataStart, atom.end ?? atom.dataStart, 4, context)) {
		switch (field.id) {
			case 0x91:
				start = ebmlUint(bytes, field)
				break
			case 0x92:
				end = ebmlUint(bytes, field)
				break
			case 0x98:
				hidden = ebmlUint(bytes, field) === 1
				break
			case 0x4598:
				enabled = ebmlUint(bytes, field, 1) !== 0
				break
			case 0x6e67:
				linked = true
				break
			case 0x4588:
				skipType = ebmlUint(bytes, field)
				break
			case 0x80:
				if (title === null) {
					for (const item of ebmlChildren(bytes, field.dataStart, field.end ?? field.dataStart, 5, context)) {
						if (item.id === 0x85) {
							title = ebmlString(bytes, item)
						}
					}
				}
				break
		}
	}

	if (start === null) {
		return null
	}

	return {
		chapter: {
			t: seconds(start / 1e9),
			...(end !== null && end > start ? { end: seconds(end / 1e9) } : {}),
			title,
			...(skipType !== null && skipType <= 7 ? { skipType } : {})
		},
		shown: !hidden && enabled && !linked
	}
}

// The default edition (else the first visible one); its top-level atoms in time order.
function parseChaptersPayload(bytes: Uint8Array, context: EbmlContext): ProbeChapter[] {
	const count: ChapterCount = { atoms: 0 }
	let chosen: EbmlElement | null = null
	let chosenRank = -1

	for (const edition of ebmlChildren(bytes, 0, bytes.length, 2, context)) {
		if (edition.id !== EDITION_ENTRY_ID) {
			continue
		}

		let hidden = false
		let isDefault = false

		for (const field of ebmlChildren(bytes, edition.dataStart, edition.end ?? edition.dataStart, 3, context)) {
			if (field.id === EDITION_FLAG_HIDDEN_ID) {
				hidden = ebmlUint(bytes, field) === 1
			} else if (field.id === EDITION_FLAG_DEFAULT_ID) {
				isDefault = ebmlUint(bytes, field) === 1
			}
		}

		// A visible default edition beats a visible one; the first of a rank wins. Hidden ones never show.
		const rank = hidden ? -1 : isDefault ? 2 : 1

		if (rank > chosenRank) {
			chosen = edition
			chosenRank = rank
		}
	}

	if (chosen === null) {
		return []
	}

	const chapters: ProbeChapter[] = []
	// Starts of the atoms that are not shown: each still ends the shown chapter before it.
	const unshown: number[] = []

	for (const atom of ebmlChildren(bytes, chosen.dataStart, chosen.end ?? chosen.dataStart, 3, context)) {
		if (atom.id !== CHAPTER_ATOM_ID) {
			continue
		}

		count.atoms++

		if (count.atoms > MAX_CHAPTER_ATOMS) {
			context.malformed = true

			break
		}

		const parsed = parseAtom(bytes, atom, context)

		if (parsed === null) {
			continue
		}

		if (parsed.shown) {
			chapters.push(parsed.chapter)
		} else {
			unshown.push(parsed.chapter.t)
		}
	}

	// Sorted before the cap, so a file storing its chapters out of order keeps its earliest ones.
	chapters.sort((a, b) => a.t - b.t)
	unshown.sort((a, b) => a - b)

	const kept = Math.min(chapters.length, MAX_CHAPTERS)
	let cursor = 0

	// A chapter without its own end runs to the next shown one; a closer unshown atom, or a shown one
	// beyond the cap, would be lost from the record, so it becomes the explicit end.
	for (let i = 0; i < kept; i++) {
		const chapter = chapters[i] as ProbeChapter

		while (cursor < unshown.length && (unshown[cursor] as number) <= chapter.t) {
			cursor++
		}

		if (chapter.end !== undefined) {
			continue
		}

		const next = chapters[i + 1]?.t
		const boundary = unshown[cursor]

		if (boundary !== undefined && (next === undefined || boundary < next)) {
			chapter.end = boundary
		} else if (i === kept - 1 && next !== undefined && next > chapter.t) {
			chapter.end = next
		}
	}

	return chapters.slice(0, kept)
}

// ── Attachments (covers) ────────────────────────────────────────────────────

// A Map, so a file name's extension never resolves an inherited object key.
const COVER_MIMES: ReadonlyMap<string, string> = new Map([
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["png", "image/png"],
	["webp", "image/webp"],
	["gif", "image/gif"],
	["bmp", "image/bmp"]
])

// Whether the cover walk may read [from, to): free inside fetched blocks, else one hop of its budget.
// False (and the record partial) once the hops are spent.
function coverMayRead(walk: Walk, from: number, to: number, hops: { count: number }): boolean {
	if (walk.source.isCached(from) && walk.source.isCached(to - 1)) {
		return true
	}

	if (hops.count >= MAX_COVER_HOPS) {
		walk.result.partial = true

		return false
	}

	hops.count++
	raiseBudget(walk.source, 2)

	return true
}

// The header at `at` inside [at, limit). Null when the hop budget is spent (partial) or no complete
// element starts there (malformed).
async function coverHeader(
	walk: Walk,
	at: number,
	limit: number,
	hops: { count: number }
): Promise<(EbmlElement & { end: number }) | null> {
	if (!coverMayRead(walk, at, Math.min(at + 12, limit), hops)) {
		return null
	}

	const element = await headerAt(walk, at, limit)
	const end = element?.end ?? null

	if (element === null || end === null || end > limit) {
		walk.context.malformed = true

		return null
	}

	return { ...element, end }
}

// Which cover an attachment's file name makes it: "cover.*", or the landscape "cover_land.*".
function coverSlot(name: string): "cover" | "coverLand" | null {
	const lower = name.toLowerCase()

	return lower.startsWith("cover.") ? "cover" : lower.startsWith("cover_land.") ? "coverLand" : null
}

// The first AttachedFile named "cover.*" and the first named "cover_land.*": their FileData's position,
// never their bytes.
async function findCover(walk: Walk, attachments: EbmlElement): Promise<void> {
	const end = Math.min(attachments.end ?? walk.segmentEnd, walk.segmentEnd)
	const hops = { count: 0 }
	const { result } = walk
	let at = attachments.dataStart

	for (let i = 0; at < end && i < MAX_EBML_CHILDREN && (result.cover === null || result.coverLand === null); i++) {
		const file = await coverHeader(walk, at, end, hops)

		if (file === null) {
			return
		}

		if (file.id === ATTACHED_FILE_ID) {
			let name: string | null = null
			let slot: "cover" | "coverLand" | null = null
			let mime: string | null = null
			let data: { offset: number; size: number } | null = null
			let field = file.dataStart

			for (let j = 0; field < file.end && j < 16 && (name === null || mime === null || data === null); j++) {
				const element = await coverHeader(walk, field, file.end, hops)

				if (element === null) {
					return
				}

				if (element.id === FILE_NAME_ID || element.id === FILE_MEDIA_TYPE_ID) {
					const length = element.end - element.dataStart

					if (length > 0 && length <= MAX_EBML_STRING_BYTES && !coverMayRead(walk, element.dataStart, element.end, hops)) {
						return
					}

					const text = await readPayload(walk, element, MAX_EBML_STRING_BYTES)
					const value = text === null ? null : utf8(text, 0, text.length)

					if (element.id === FILE_NAME_ID) {
						name = value
						slot = value === null ? null : coverSlot(value)
					} else {
						mime = value
					}

					// Only the name decides, so a font's (or a second cover's) other fields are not worth a hop.
					if (name !== null && (slot === null || result[slot] !== null)) {
						break
					}
				} else if (element.id === FILE_DATA_ID) {
					data = { offset: element.dataStart, size: element.end - element.dataStart }
				}

				field = element.end
			}

			if (name !== null && slot !== null && result[slot] === null && data !== null) {
				const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()

				result[slot] = { ...data, mime: mime ?? COVER_MIMES.get(extension) ?? "image/*" }
			}
		}

		at = file.end
	}
}

// ── Segment walk ────────────────────────────────────────────────────────────

async function visit(walk: Walk, element: EbmlElement): Promise<void> {
	const wanted = needs(walk.tier).includes(element.id)

	switch (element.id) {
		case SEEK_HEAD_ID: {
			if (walk.visitedSeekHeads.has(element.start)) {
				return
			}

			walk.visitedSeekHeads.add(element.start)

			const bytes = await readPayload(walk, element, MAX_SEEK_HEAD_BYTES)

			if (bytes !== null) {
				parseSeekHead(walk, bytes)
			}

			return
		}
		case CUES_ID:
			walk.result.index = "cues"
			walk.cuesAt ??= element.start

			return
		case INFO_ID:
		case TRACKS_ID:
		case CHAPTERS_ID: {
			if (!wanted || walk.visited.has(element.id)) {
				return
			}

			walk.visited.add(element.id)

			const cap = element.id === INFO_ID ? MAX_INFO_BYTES : element.id === TRACKS_ID ? MAX_TRACKS_BYTES : MAX_CHAPTERS_BYTES
			const bytes = await readPayload(walk, element, cap)

			if (bytes === null) {
				return
			}

			if (element.id === INFO_ID) {
				parseInfo(walk, bytes)
			} else if (element.id === TRACKS_ID) {
				walk.result.tracks = await parseTracksPayload(bytes, walk.context, walk.keyframes)
				walk.result.tracksFound = true
			} else {
				walk.result.chapters = parseChaptersPayload(bytes, walk.context)
			}

			return
		}
		case ATTACHMENTS_ID:
			if (wanted && !walk.visited.has(element.id)) {
				walk.visited.add(element.id)
				await findCover(walk, element)
			}

			return
	}
}

function remaining(walk: Walk): number[] {
	return needs(walk.tier).filter(id => !walk.visited.has(id))
}

// Scans forward from a corrupt header for the next top-level element ID, in place inside the block
// already fetched and at most once per block, so a run of corrupt headers costs one pass over it.
async function resync(walk: Walk, from: number): Promise<number | null> {
	const index = Math.floor(from / BLOCK_BYTES)
	const block = walk.resyncedBlocks.has(index) ? null : await walk.source.residentBlock(from)

	walk.resyncedBlocks.add(index)

	if (block === null) {
		return null
	}

	const end = Math.min(block.length, walk.segmentEnd - index * BLOCK_BYTES)

	for (let i = from - index * BLOCK_BYTES + 1; i + 4 <= end; i++) {
		const id = (block[i] ?? 0) * 0x1000000 + ((block[i + 1] ?? 0) << 16) + ((block[i + 2] ?? 0) << 8) + (block[i + 3] ?? 0)

		if (TOP_LEVEL_IDS.has(id)) {
			return index * BLOCK_BYTES + i
		}
	}

	return null
}

// Walks the Segment's children from its start until a Cluster, the tier's needs are met, or (when a
// SeekHead says where everything is) the next header would cost a download.
async function walkSequential(walk: Walk): Promise<void> {
	let at = walk.segmentStart

	while (at < walk.segmentEnd && remaining(walk).length > 0) {
		walk.elements++

		if (walk.elements > MAX_EBML_CHILDREN) {
			throw new MalformedError("too many top-level elements")
		}

		if (walk.hasSeekHead && !walk.source.isCached(at) && remaining(walk).every(id => walk.seeks.has(id) || !MANDATORY.has(id))) {
			return
		}

		const element = await headerAt(walk, at, walk.segmentEnd)

		if (element === null) {
			walk.context.malformed = true

			const next = await resync(walk, at)

			if (next === null) {
				return
			}

			at = next
			continue
		}

		if (element.id === CLUSTER_ID) {
			return
		}

		if (element.end === null || element.end > walk.segmentEnd) {
			// Unknown sizes are legal only for the Segment and Clusters.
			walk.context.malformed = true

			return
		}

		await visit(walk, element)
		at = element.end
	}
}

// Visits what the SeekHead points at that the sequential walk did not reach, in file order, following
// a second SeekHead first when the needs are not all located yet.
async function walkSeeks(walk: Walk): Promise<void> {
	for (let round = 0; round < 2; round++) {
		const unlocated = remaining(walk).some(id => !walk.seeks.has(id))
		const secondary = (walk.seeks.get(SEEK_HEAD_ID) ?? []).filter(at => !walk.visitedSeekHeads.has(at))

		if (!unlocated || secondary.length === 0) {
			break
		}

		for (const at of secondary.slice(0, 2)) {
			await jump(walk, at, SEEK_HEAD_ID)
			// Recorded even when the jump found no SeekHead there, so the next round moves on.
			walk.visitedSeekHeads.add(at)
		}
	}

	const targets = remaining(walk)
		.flatMap(id => (walk.seeks.get(id) ?? []).slice(0, 1).map(at => ({ id, at })))
		.sort((a, b) => a.at - b.at)

	for (const { id, at } of targets) {
		if (!walk.visited.has(id)) {
			await jump(walk, at, id)
		}
	}
}

async function jump(walk: Walk, at: number, expected: number): Promise<void> {
	if (walk.tier !== "card") {
		raiseBudget(walk.source, 2)
	}

	const element = await headerAt(walk, at, walk.segmentEnd)

	if (element?.id !== expected || element.end === null || element.end > walk.segmentEnd) {
		walk.context.malformed = true

		return
	}

	await visit(walk, element)
}

// EBML header (DocType matroska or webm), then the Segment. Throws ReadBudgetError and MalformedError
// with whatever was found already in `result`.
export async function walkMatroska(source: BlockSource, tier: ProbeTier, result: ParsedContainer, keyframes = false): Promise<void> {
	const context: EbmlContext = { malformed: false }
	const head = await readBytes(source, 0, Math.min(12, source.size))
	const ebml = parseElementHeader(head, 0)

	if (
		typeof ebml === "string" ||
		ebml.id !== EBML_ID ||
		ebml.end === null ||
		ebml.end - ebml.dataStart > MAX_EBML_HEADER_BYTES ||
		ebml.end > source.size
	) {
		throw new UnsupportedContainerError()
	}

	const header = await readBytes(source, ebml.dataStart, ebml.end - ebml.dataStart)
	let docType = "matroska"

	for (const field of ebmlChildren(header, 0, header.length, 1, context)) {
		if (field.id === DOC_TYPE_ID) {
			docType = ebmlString(header, field) ?? docType
		}
	}

	if (docType !== "matroska" && docType !== "webm") {
		throw new UnsupportedContainerError()
	}

	result.container = docType === "webm" ? "webm" : "mkv"

	const segment = await readBytes(source, ebml.end, Math.max(0, Math.min(12, source.size - ebml.end)))
	const parsed = parseElementHeader(segment, 0)

	if (typeof parsed === "string" || parsed.id !== SEGMENT_ID) {
		throw new MalformedError("no Segment")
	}

	const segmentStart = ebml.end + parsed.dataStart
	const walk: Walk = {
		source,
		tier,
		result,
		context,
		segmentStart,
		// A Segment cut short by an unfinished upload still has its header elements, so it is read to the file's end.
		segmentEnd: parsed.end === null ? source.size : Math.min(source.size, ebml.end + parsed.end),
		seeks: new Map(),
		hasSeekHead: false,
		visited: new Set(),
		visitedSeekHeads: new Set(),
		resyncedBlocks: new Set(),
		elements: 0,
		keyframes,
		timestampScale: 1_000_000,
		cuesAt: null
	}

	try {
		await walkSequential(walk)
		await walkSeeks(walk)
	} finally {
		// No Cues entry in a SeekHead that does not defer to another one means the file has none.
		const deferred = (walk.seeks.get(SEEK_HEAD_ID) ?? []).some(at => !walk.visitedSeekHeads.has(at))

		if (result.index === null && walk.hasSeekHead) {
			result.index = walk.seeks.has(CUES_ID) ? "cues" : deferred ? null : "none"
		}

		result.partial ||= context.malformed

		result.timestampScale = walk.timestampScale

		if (keyframes) {
			result.cues = { segmentStart, timestampScale: walk.timestampScale, at: walk.cuesAt ?? walk.seeks.get(CUES_ID)?.[0] ?? null }
		}
	}
}
