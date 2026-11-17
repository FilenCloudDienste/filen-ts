import { parseSubtitle, subtitleFormatFromExtension } from "@filen/shared/videos"
import { withoutFormatControls } from "@filen/shared/formatControls"
import { cueSegments } from "@/lib/media/subtitles/subtitleStyle.logic"

// A subtitle file's cues as the cue table shows them: times in seconds, text as plain text.

export type SubtitleReading =
	| { readonly status: "ok"; readonly starts: Float64Array; readonly ends: Float64Array; readonly texts: readonly string[] }
	// Not a format the parsers read (a `.sub` that is no MicroDVD), or no cues.
	| { readonly status: "unreadable" }

export type SubtitleCues = Extract<SubtitleReading, { status: "ok" }>

// A cue's text without its markup (the player's own reading of cue payloads, styles dropped), and without format and
// bidi controls, as every viewer shows a file's text.
export function cuePlainText(text: string): string {
	return withoutFormatControls(
		cueSegments(text)
			.map(segment => segment.text)
			.join("")
	)
}

// Parsed by its extension's format (the text-family worker runs this).
export function readSubtitleText(text: string, extension: string): SubtitleReading {
	const format = subtitleFormatFromExtension(extension)
	const store = format === null ? null : parseSubtitle(text, format)

	if (store === null || store.texts.length === 0) {
		return { status: "unreadable" }
	}

	return { status: "ok", starts: store.starts, ends: store.ends, texts: store.texts.map(cuePlainText) }
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0")
}

// 01:02:03.450; hours always shown, so a column lines up.
export function formatCueTime(seconds: number): string {
	const millis = Math.max(0, Math.round(seconds * 1000))
	const hours = Math.floor(millis / 3_600_000)
	const minutes = Math.floor(millis / 60_000) % 60
	const secs = Math.floor(millis / 1000) % 60

	return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(millis % 1000, 3)}`
}

// 01:42:10, for the file's length.
export function formatCueSpan(seconds: number): string {
	return formatCueTime(seconds).slice(0, 8)
}

// The latest end of any cue.
export function cuesSpan(cues: SubtitleCues): number {
	let latest = 0

	for (const end of cues.ends) {
		if (end > latest) latest = end
	}

	return latest
}

// The indices of the cues whose text holds `query` (case-insensitive); null for an empty query, which keeps every cue.
// `lowered` is the cue texts lowercased, built once by the caller.
export function matchingCues(lowered: readonly string[], query: string): Int32Array | null {
	const needle = query.trim().toLowerCase()

	if (needle === "") {
		return null
	}

	const hits: number[] = []

	for (let index = 0; index < lowered.length; index++) {
		if (lowered[index]?.includes(needle) === true) hits.push(index)
	}

	return Int32Array.from(hits)
}
