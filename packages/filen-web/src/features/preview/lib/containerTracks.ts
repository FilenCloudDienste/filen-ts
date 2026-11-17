import { codecStringAlternatives, type MediaCodec, type ProbeContainer } from "@filen/shared/videos"

// The audio/video codecs a preview names when a browser cannot play part of a file, and how to ask a
// browser whether it can.

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
	mpeg4: { kind: "video", label: "MPEG-4 Part 2", query: 'video/mp4; codecs="mp4v.20.9"' },
	mpeg1: { kind: "video", label: "MPEG-1 Video", query: 'video/mp4; codecs="mp4v.6a"' },
	mpeg2: { kind: "video", label: "MPEG-2 Video", query: 'video/mp4; codecs="mp4v.61"' },
	vc1: { kind: "video", label: "VC-1", query: 'video/mp4; codecs="vc-1"' },
	wmv: { kind: "video", label: "Windows Media Video", query: 'video/x-ms-wmv; codecs="wmv3"' },
	h263: { kind: "video", label: "H.263", query: 'video/3gpp; codecs="s263"' },
	vp6: { kind: "video", label: "VP6", query: 'video/x-flv; codecs="vp6"' },
	mjpeg: { kind: "video", label: "Motion JPEG", query: 'video/x-motion-jpeg; codecs="mjpg"' },
	wma: { kind: "audio", label: "WMA", query: 'audio/x-ms-wma; codecs="wmav2"' },
	wmapro: { kind: "audio", label: "WMA Pro", query: 'audio/x-ms-wma; codecs="wmapro"' },
	wmalossless: { kind: "audio", label: "WMA Lossless", query: 'audio/x-ms-wma; codecs="wmalossless"' },
	mp1: { kind: "audio", label: "MP1", query: 'audio/mpeg; codecs="mp1"' },
	mp2: { kind: "audio", label: "MP2", query: 'audio/mpeg; codecs="mp2"' },
	amr: { kind: "audio", label: "AMR", query: 'audio/3gpp; codecs="samr"' },
	amrwb: { kind: "audio", label: "AMR-WB", query: 'audio/3gpp; codecs="sawb"' },
	pcm: { kind: "audio", label: "PCM", query: 'audio/wav; codecs="1"' },
	adpcm: { kind: "audio", label: "ADPCM", query: 'audio/wav; codecs="2"' },
	speex: { kind: "audio", label: "Speex", query: 'audio/ogg; codecs="speex"' }
} as const satisfies Record<MediaCodec, { kind: TrackKind; label: string; query: string }>

export type CodecId = MediaCodec

// Each container a probe reads, by the name a "can't play these files" message gives it.
export const CONTAINER_LABELS = {
	mp4: "MP4",
	mov: "QuickTime",
	mkv: "Matroska",
	webm: "WebM",
	ts: "MPEG-TS",
	avi: "AVI",
	flv: "Flash Video",
	asf: "Windows Media",
	ps: "MPEG",
	ogg: "Ogg"
} as const satisfies Record<ProbeContainer, string>

// `codec` is null for a track whose format this module does not recognise.
export interface ContainerTrack {
	kind: TrackKind
	codec: CodecId | null
}

// A query once per equivalent spelling of its codec (Firefox knows MP3 in MP4 only as "mp3").
export function queryAlternatives(query: string): string[] {
	const match = /codecs="([^",]+)"/.exec(query)
	const codec = match?.[1]

	return codec === undefined
		? [query]
		: codecStringAlternatives(codec).map(spelling => query.replace(`codecs="${codec}"`, `codecs="${spelling}"`))
}

// Asks both decoder surfaces: MediaSource answers for what an element can stream, canPlayType for what
// it plays from a plain src. Either saying yes, to any spelling of the codec, means the codec is not the problem.
export function browserCanPlay(media: HTMLMediaElement): (query: string) => boolean {
	return query =>
		queryAlternatives(query).some(
			spelling => (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(spelling)) || media.canPlayType(spelling) !== ""
		)
}
