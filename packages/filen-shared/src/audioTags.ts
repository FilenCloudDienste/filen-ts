// The slice of a music-metadata parse result both apps read, restated structurally so this package never
// depends on music-metadata itself. Fields are read defensively (null included): a parse result is
// runtime data from a third-party parser.
export interface ParsedAudioTags {
	common: {
		title?: string | null
		artist?: string | null
		albumartist?: string | null
		album?: string | null
		date?: string | null
	}
	format: {
		duration?: number | null
	}
}

export interface NormalizedTrackTags {
	title: string | null
	artist: string | null
	album: string | null
	date: string | null
	durationSec: number | null
}

// ID3 frames routinely carry NUL terminators and padding, and a frame that is present but blank must read
// as "no tag", not as an empty title that hides the file-name fallback.
function cleanTag(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null
	}

	const cleaned = value.replaceAll("\u0000", "").trim()

	return cleaned.length > 0 ? cleaned : null
}

// Whole seconds; a sub-second clip still reads as 1s rather than as a missing duration.
function cleanDuration(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null
	}

	return Math.max(1, Math.round(value))
}

export function normalizeTrackTags(parsed: ParsedAudioTags): NormalizedTrackTags {
	return {
		title: cleanTag(parsed.common.title),
		artist: cleanTag(parsed.common.artist) ?? cleanTag(parsed.common.albumartist),
		album: cleanTag(parsed.common.album),
		date: cleanTag(parsed.common.date),
		durationSec: cleanDuration(parsed.format.duration)
	}
}
