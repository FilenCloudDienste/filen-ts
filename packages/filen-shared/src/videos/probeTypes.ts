import type { FragmentIndex } from "./probeFragments"

// What a video file's container says about it, read from its headers without decoding anything. Kept
// JSON-serialisable and small (a few hundred bytes) so it can be cached per file uuid.

// card: badges (codecs, size, duration, audio list) in at most CARD_BLOCK_READS downloads.
// full: everything, for a detail page or playback. cover: the card's fields plus where an embedded
// cover sits, the track headers being on its way.
export type ProbeTier = "card" | "full" | "cover"

export const MEDIA_CODECS = [
	"aac",
	"mp3",
	"ac3",
	"eac3",
	"dts",
	"truehd",
	"opus",
	"vorbis",
	"flac",
	"alac",
	"h264",
	"hevc",
	"av1",
	"vp9",
	"vp8",
	"theora",
	"mpeg4"
] as const

export type MediaCodec = (typeof MEDIA_CODECS)[number]

export const PROBE_CONTAINERS = ["mp4", "mov", "mkv", "webm", "ts"] as const

// "ts" is an MPEG transport stream: 188-byte packets, or 192-byte BDAV (.m2ts/.mts).
export type ProbeContainer = (typeof PROBE_CONTAINERS)[number]

// Where a player finds keyframes: the MP4 sample tables, Matroska Cues, a fragmented MP4's mfra, or nowhere.
export type ProbeIndex = "moov" | "cues" | "mfra" | "none"

export type ProbeTransfer = "sdr" | "pq" | "hlg"

export interface ProbeVideo {
	codec: MediaCodec | null
	// The MP4 sample entry type; for Matroska the type a remux would write (avc1, hvc1, av01, vp09), else the CodecID.
	fourcc: string
	codecString: string | null
	w: number
	h: number
	// Pixel aspect ratio, width over height.
	par: number
	// Clockwise degrees the decoded picture is turned for display.
	rotation: number
	bitDepth: number | null
	transfer: ProbeTransfer
	dv?: { profile: number; compat: number }
}

export interface ProbeAudio {
	id: number
	codec: MediaCodec | null
	codecString: string | null
	ch: number | null
	rate: number | null
	// BCP 47 when the container has it, else its legacy ISO 639-2 code; null for undetermined.
	lang: string | null
	name: string | null
	def: boolean
	forced: boolean
	commentary: boolean
}

export interface ProbeSubtitle {
	id: number
	// Matroska CodecID or MP4 sample entry type.
	codecId: string
	lang: string | null
	name: string | null
	def: boolean
	forced: boolean
	hi: boolean
}

export interface ProbeChapter {
	t: number
	end?: number
	title: string | null
	skipType?: number
}

// The image's own bytes inside the file; never read by the probe.
export interface ProbeCover {
	offset: number
	size: number
	mime: string
}

export interface VideoProbe {
	v: 1
	container: ProbeContainer
	durationSec: number | null
	index: ProbeIndex | null
	video: ProbeVideo | null
	audio: ProbeAudio[]
	subs: ProbeSubtitle[]
	chapters: ProbeChapter[]
	cover: ProbeCover | null
	// A landscape cover (Matroska's "cover_land.*" attachment). Absent from a probe stored before it was read.
	coverLand?: ProbeCover | null
	// The tier's read budget ran out or a structure was malformed before everything was found.
	partial: boolean
}

// A box's or element's payload in the file, `end` exclusive.
export interface ByteRange {
	start: number
	end: number
}

// The sample tables of an MP4 picture track, located but not read.
export interface SampleTables {
	// mdhd's ticks per second, which the tables count in.
	timescale: number
	stts: ByteRange | null
	// Null when every sample is a keyframe.
	stss: ByteRange | null
	stsc: ByteRange | null
	stsz: ByteRange | null
	chunkOffsets: ByteRange | null
	// co64 rather than stco.
	wideOffsets: boolean
}

// What a decoder needs to find and decode a picture track's keyframes; only a walk asked for keyframes fills it.
export interface VideoDecodeInfo {
	// MP4 track_ID or Matroska TrackNumber.
	track: number
	// The configuration record a decoder is configured with (avcC, hvcC, av1C), for codecs that have one.
	description: Uint8Array | null
	// Matroska frames stored through a ContentEncoding (header stripping, compression): not decodable as read.
	encodedFrames: boolean
	tables: SampleTables | null
}

// Where a Matroska Segment keeps its Cues; only a walk asked for keyframes fills it.
export interface CuesLocation {
	segmentStart: number
	// Nanoseconds per Matroska tick.
	timestampScale: number
	at: number | null
}

export type ParsedTrack =
	| { kind: "video"; enabled: boolean; video: ProbeVideo; decode?: VideoDecodeInfo }
	// `config`: the decoder configuration no browser decoder takes from elsewhere (ALAC's magic cookie);
	// never part of a stored probe.
	| { kind: "audio"; enabled: boolean; audio: ProbeAudio; config?: Uint8Array | null }
	// `frames`: how a Matroska track's frames are compressed (zlib = algorithm 0, header stripping = 3).
	| {
			kind: "subtitle"
			enabled: boolean
			sub: ProbeSubtitle
			frames?: { algorithm: number; settings: Uint8Array } | "unsupported" | null
	  }

// A container walker's result, before a tier's record is cut from it.
export interface ParsedContainer {
	container: ProbeContainer
	durationSec: number | null
	index: ProbeIndex | null
	// In file order. `tracksFound` is false when the track list was never located.
	tracks: ParsedTrack[]
	tracksFound: boolean
	chapters: ProbeChapter[]
	cover: ProbeCover | null
	coverLand: ProbeCover | null
	partial: boolean
	cues?: CuesLocation
	// A fragmented MP4's mfra index with what reading its moofs takes; only a walk asked for keyframes fills it.
	fragments?: FragmentIndex
	// Matroska: nanoseconds per tick of the Segment's timestamps.
	timestampScale?: number
}

export const MAX_CHAPTERS = 64
