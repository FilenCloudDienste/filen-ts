import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import type { VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"

// Recipes, sources and browsers for the video export's tests.

export function recipeFor(duration: number, overrides: Partial<VideoEditRecipe> = {}): VideoEditRecipe {
	return {
		keep: [{ start: 0, end: duration }],
		crop: null,
		rotate: 0,
		flipH: false,
		flipV: false,
		output: { resolution: "original", quality: "high" },
		audio: { mute: false, gainDb: 0, keepTracks: "first" },
		speed: 1,
		adjust: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, warmth: 0, tint: 0, saturation: 0, vibrance: 0 },
		filter: null,
		text: [],
		precise: false,
		removeLocation: false,
		...overrides
	}
}

// A 60 s 1080p H.264 + AAC clip with a key frame every 2 s.
export function sourceInfo(overrides: Partial<VideoSourceInfo> = {}): VideoSourceInfo {
	return {
		duration: 60,
		width: 1920,
		height: 1080,
		codedWidth: 1920,
		codedHeight: 1080,
		rotation: 0,
		frameRate: 30,
		videoCodec: "avc1.640028",
		transfer: "sdr",
		bitDepth: 8,
		keyframes: Float64Array.from({ length: 30 }, (_, index) => index * 2),
		audio: [{ number: 1, codec: "mp4a.40.2", channels: 2, language: "eng" }],
		container: "mp4",
		hasSubtitles: false,
		hasChapters: false,
		hasLocation: false,
		bytes: 60_000_000,
		previewable: true,
		...overrides
	}
}

// Chromium on a desktop: every encoder.
export const ALL_ENCODERS: EncodeCapabilities = {
	videoEncoder: true,
	audioEncoder: true,
	video: { avc: true, hevc: true, hevcMain10: true, vp9: true, av1: true },
	firstVideoCodec: "avc",
	audio: { aac: true, opus: true }
}

// Firefox desktop: video encoders, audio encoders but no AAC (the wasm encoder stands in).
export const FIREFOX_DESKTOP: EncodeCapabilities = {
	videoEncoder: true,
	audioEncoder: true,
	video: { avc: true, hevc: false, hevcMain10: false, vp9: true, av1: true },
	firstVideoCodec: "avc",
	audio: { aac: false, opus: true }
}

// Firefox on Android: no WebCodecs at all.
export const NO_WEBCODECS: EncodeCapabilities = {
	videoEncoder: false,
	audioEncoder: false,
	video: { avc: false, hevc: false, hevcMain10: false, vp9: false, av1: false },
	firstVideoCodec: null,
	audio: { aac: false, opus: false }
}
