import { MAX_SUBTITLE_CHARS, applyCueOffset, type CueStore } from "./subtitles/cues"
import { parseAss } from "./subtitles/ass"
import { DEFAULT_MICRODVD_FPS, isMicroDvd, parseMicroDvd } from "./subtitles/microdvd"
import { parseSmi } from "./smi"
import { subtitleFormat, type SidecarSubtitleFormat } from "./sidecars"
import { parseSrt } from "./subtitles/srt"
import { parseVtt } from "./subtitles/vtt"

// The parser a text subtitle takes; "sub" is told from VobSub by its content (`isMicroDvd`).
export type SubtitleFormat = "srt" | "vtt" | "ass" | "smi" | "sub"

// The parser for a sidecar's format; image formats (VobSub, PGS) have none.
export function parseFormatOf(format: SidecarSubtitleFormat): SubtitleFormat | null {
	switch (format) {
		case "srt":
		case "vtt":
		case "smi":
			return format
		case "ass":
		case "ssa":
			return "ass"
		case "microdvd":
			return "sub"
		default:
			return null
	}
}

// By file extension, through the one sidecar extension table; `.sub` takes the content check.
export function subtitleFormatFromExtension(extension: string): SubtitleFormat | null {
	const format = subtitleFormat(extension.replace(/^\./, "").toLowerCase(), false)

	return format === null ? null : parseFormatOf(format)
}

export interface ParseSubtitleOptions {
	fps?: number
	// Seconds, positive = later.
	offset?: number
	// SAMI: pick the track with this class or language; defaults to the first.
	smiClass?: string
	smiLang?: string
}

// Parses text of a known format into one cue store; null when refused (over the size cap, VobSub `.sub`, no SAMI track).
export function parseSubtitle(text: string, format: SubtitleFormat, options: ParseSubtitleOptions = {}): CueStore | null {
	if (text.length > MAX_SUBTITLE_CHARS) {
		return null
	}

	let store: CueStore | null

	switch (format) {
		case "srt":
			store = parseSrt(text)

			break
		case "vtt":
			store = parseVtt(text)

			break
		case "ass":
			store = parseAss(text)

			break
		case "sub":
			store = isMicroDvd(text) ? parseMicroDvd(text, options.fps ?? DEFAULT_MICRODVD_FPS) : null

			break
		case "smi": {
			const tracks = parseSmi(text)

			if (tracks === null || tracks.length === 0) {
				return null
			}

			const picked =
				(options.smiClass !== undefined ? tracks.find(track => track.className === options.smiClass) : undefined) ??
				(options.smiLang !== undefined ? tracks.find(track => track.lang === options.smiLang) : undefined) ??
				tracks[0]

			store = picked === undefined ? null : picked.store

			break
		}
	}

	return store === null || options.offset === undefined ? store : applyCueOffset(store, options.offset)
}
