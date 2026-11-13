import { canEncodeAudio, canEncodeVideo, getFirstEncodableVideoCodec, type VideoCodec } from "mediabunny"
import {
	ENCODE_PROBE_HEIGHT,
	ENCODE_PROBE_WIDTH,
	EXPORT_VIDEO_CODECS,
	HEVC_MAIN10_CODEC_STRING,
	type EncodeCapabilities
} from "@/lib/media/playback/capabilities.logic"

// The encoders an export can use, through mediabunny's own checks (which encode a frame where isConfigSupported is
// unreliable, Firefox). Only the browser's own encoders count: none is registered in this worker.

const VIDEO_OPTIONS = { width: ENCODE_PROBE_WIDTH, height: ENCODE_PROBE_HEIGHT, hardwareAcceleration: "no-preference" } as const

// A probe that throws (a config the browser rejects outright) is a no.
function quiet(answer: Promise<boolean>): Promise<boolean> {
	return answer.catch(() => false)
}

function exportCodec(codec: VideoCodec | null): EncodeCapabilities["firstVideoCodec"] {
	return EXPORT_VIDEO_CODECS.find(candidate => candidate === codec) ?? null
}

export async function probeEncodeCapabilities(): Promise<EncodeCapabilities> {
	const audio = Promise.all([quiet(canEncodeAudio("aac")), quiet(canEncodeAudio("opus"))])
	// One video check at a time: on Firefox each one encodes a 1080p frame.
	const avc = await quiet(canEncodeVideo("avc", VIDEO_OPTIONS))
	const hevc = await quiet(canEncodeVideo("hevc", VIDEO_OPTIONS))
	const hevcMain10 = hevc && (await quiet(canEncodeVideo("hevc", { ...VIDEO_OPTIONS, fullCodecString: HEVC_MAIN10_CODEC_STRING })))
	const vp9 = await quiet(canEncodeVideo("vp9", VIDEO_OPTIONS))
	const av1 = await quiet(canEncodeVideo("av1", VIDEO_OPTIONS))
	// Answered from the memo the checks above filled.
	const first = await getFirstEncodableVideoCodec([...EXPORT_VIDEO_CODECS], VIDEO_OPTIONS).catch(() => null)
	const [aac, opus] = await audio

	return {
		videoEncoder: typeof VideoEncoder !== "undefined",
		audioEncoder: typeof AudioEncoder !== "undefined",
		video: { avc, hevc, hevcMain10, vp9, av1 },
		firstVideoCodec: exportCodec(first),
		audio: { aac, opus }
	}
}
