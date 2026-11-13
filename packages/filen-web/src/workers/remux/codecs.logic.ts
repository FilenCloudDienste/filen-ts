import type { AudioCodec } from "mediabunny"
import { codecStringAlternatives, hevcCodecString } from "@filen/shared/videos"

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
	return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source)
}

// The codec string of a video track as the fragmented-MP4 output carries it. The muxer always writes an
// `hvc1` sample entry for HEVC, so the string says `hvc1` whatever the source's own entry was, with or
// without a decoder configuration record to rebuild it from.
export function outputVideoCodecString(codec: string, config: { codec: string; description?: AllowSharedBufferSource }): string {
	if (codec !== "hevc") {
		return config.codec
	}

	const rebuilt = config.description === undefined ? null : hevcCodecString({ fourcc: "hvc1", hvcC: bytesOf(config.description) })

	return rebuilt ?? config.codec.replace(/^hev1\./, "hvc1.")
}

// Audio codecs whose packets go into fragmented MP4 as they are; the page's MediaSource still decides
// whether it takes them.
const COPYABLE_AUDIO: ReadonlySet<AudioCodec> = new Set<AudioCodec>(["aac", "opus", "mp3", "flac", "ac3", "eac3"])

// Raw PCM (WAVE, some Matroska and QuickTime tracks) has no fragmented-MP4 sample entry any MediaSource takes: it is only
// ever re-encoded. The demuxer decodes it itself, without WebCodecs.
const PCM_AUDIO = [
	"pcm-s16",
	"pcm-s16be",
	"pcm-s24",
	"pcm-s24be",
	"pcm-s32",
	"pcm-s32be",
	"pcm-f32",
	"pcm-f32be",
	"pcm-f64",
	"pcm-f64be",
	"pcm-u8",
	"pcm-s8",
	"ulaw",
	"alaw"
] as const satisfies readonly AudioCodec[]

// Codecs that can be decoded (a WebCodecs decoder, the demuxer's own PCM decoding or a registered decoder)
// and re-encoded.
const TRANSCODABLE_AUDIO: ReadonlySet<AudioCodec> = new Set<AudioCodec>([
	"ac3",
	"eac3",
	"dts",
	"flac",
	"mp3",
	"vorbis",
	"opus",
	"aac",
	...PCM_AUDIO
])

// The codec string a copied track's MIME carries: the page's chosen spelling when it is one of the codec's.
// The sample entry is the same either way (MP3 is mp4a with object type 0x6B).
export function copyCodecString(codec: string, chosen: string | null): string {
	return chosen !== null && codecStringAlternatives(codec).includes(chosen) ? chosen : codec
}

export function isCopyableAudio(codec: AudioCodec | null): codec is AudioCodec {
	return codec !== null && COPYABLE_AUDIO.has(codec)
}

export function isTranscodableAudio(codec: AudioCodec | null): codec is AudioCodec {
	return codec !== null && TRANSCODABLE_AUDIO.has(codec)
}

// Tracks that go to FFmpeg's own reader once the container walk names them: a codec mediabunny does not know, and
// TrueHD, which it names but has no decoder for. That reader batches TrueHD's access units (a few dozen samples
// each), where mediabunny's decoder registry would post every one to the decoder worker on its own.
export function isFfmpegReaderAudio(codec: AudioCodec | null): boolean {
	return codec === null || codec === "truehd"
}
