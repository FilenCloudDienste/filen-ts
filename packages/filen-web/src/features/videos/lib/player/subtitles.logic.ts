import {
	normalizeLanguage,
	selectSubtitleTrack,
	type RememberedSubtitle,
	type SidecarSubtitleFormat,
	type SmiTrack,
	type SubtitleTrackInfo,
	type VideoProbe
} from "@filen/shared/videos"
import { embeddedSubtitleSupport } from "@/lib/media/playback/embeddedCues"
import type { VideoFileRef, VideoPartView } from "@/workers/videoIndex/view.logic"

// The parser for a sidecar's format, from the one shared table.
export { parseFormatOf } from "@filen/shared/videos"

// The subtitles a part offers: sidecars beside it (read when chosen, one read each) and the tracks inside the
// file. Text tracks inside a Matroska or MP4 file come from the remux engine's taps over what playback reads; image
// formats (PGS, VobSub) and other text formats (TTML, closed captions, a fragmented MP4's text) can't be shown.

// "playback": a text track this browser can only show through a remux that doesn't play the file whole.
export type SubtitleUnavailable = "image" | "embedded" | "playback"

export interface PlayerSubtitleTrack {
	// "s:<stable uuid>" for a sidecar, "e:<track id>" for a track in the file.
	id: string
	lang: string | null
	// Title from the name or the track ("Commentary"); may be empty.
	title: string
	forced: boolean
	hi: boolean
	isDefault: boolean
	external: boolean
	file: VideoFileRef | null
	format: SidecarSubtitleFormat | null
	// A SAMI file's class this track shows; absent for its first (or only) class and for every other format.
	smiClass?: string
	unavailable: SubtitleUnavailable | null
}

// A SAMI file's language classes, as its content names them (the sidecar reader reads them).
export type SmiClasses = readonly Pick<SmiTrack, "className" | "lang">[]

// What the subtitle menu's choice is: Smart (resolved per item), off, or one track.
export type SubtitleChoice = { kind: "auto" } | { kind: "off" } | { kind: "track"; id: string }

// `smiClasses` (by file uuid): a SAMI file with several classes is one track per class. The first keeps the file's
// own id, so a choice made before its classes were read still holds. `embeddedTextBlocked`: the player found that no
// remux plays this file whole here (PlayerSnapshot.embeddedTextBlocked).
export function subtitleTracksOf(
	part: VideoPartView,
	probe: VideoProbe | null,
	smiClasses?: ReadonlyMap<string, SmiClasses>,
	embeddedTextBlocked = false
): PlayerSubtitleTrack[] {
	const tracks: PlayerSubtitleTrack[] = []

	for (const subtitle of part.subtitles) {
		const track: PlayerSubtitleTrack = {
			id: `s:${subtitle.file.stableUuid}`,
			lang: subtitle.language,
			title: subtitle.title,
			forced: subtitle.forced,
			hi: subtitle.sdh,
			isDefault: subtitle.isDefault,
			external: true,
			file: subtitle.file,
			format: subtitle.format,
			unavailable: subtitle.format === "pgs" || subtitle.format === "vobsub" ? "image" : null
		}
		const classes = subtitle.format === "smi" ? smiClasses?.get(subtitle.file.uuid) : undefined

		if (classes === undefined || classes.length < 2) {
			tracks.push(track)

			continue
		}

		classes.forEach((smi, index) => {
			tracks.push({
				...track,
				id: index === 0 ? track.id : `${track.id}:${smi.className}`,
				lang: smi.lang ?? track.lang,
				// Told apart by the class's name when its style names no language, by its place when it has no name either.
				title:
					smi.lang !== null || track.title.length > 0
						? track.title
						: smi.className.length > 0
							? smi.className
							: `#${String(index + 1)}`,
				isDefault: track.isDefault && index === 0,
				...(index === 0 ? {} : { smiClass: smi.className })
			})
		})
	}

	for (const sub of probe?.subs ?? []) {
		const support = probe === null ? "unsupported" : embeddedSubtitleSupport(probe, sub)

		tracks.push({
			id: `e:${String(sub.id)}`,
			lang: sub.lang,
			title: sub.name ?? "",
			forced: sub.forced,
			hi: sub.hi,
			isDefault: sub.def,
			external: false,
			file: null,
			format: null,
			unavailable: support === "text" ? (embeddedTextBlocked ? "playback" : null) : support === "image" ? "image" : "embedded"
		})
	}

	return tracks
}

function selectionInfo(track: PlayerSubtitleTrack): SubtitleTrackInfo {
	return {
		lang: track.lang,
		forced: track.forced,
		default: track.isDefault,
		hi: track.hi,
		external: track.external,
		unsupported: track.unavailable !== null
	}
}

// The track a choice shows; null for none. Smart takes the series' remembered choice into account.
export function resolveSubtitleChoice(params: {
	choice: SubtitleChoice
	tracks: readonly PlayerSubtitleTrack[]
	audioLang: string | null
	userLanguages: readonly string[]
	remembered: RememberedSubtitle | "none" | null
}): PlayerSubtitleTrack | null {
	const { choice, tracks } = params

	if (choice.kind === "off") {
		return null
	}

	// A track the item doesn't have (a stale link) is no choice at all: Smart decides, with the series' memory.
	const picked = choice.kind === "track" ? tracks.find(entry => entry.id === choice.id) : undefined

	if (picked !== undefined) {
		return picked.unavailable === null ? picked : null
	}

	const index = selectSubtitleTrack(tracks.map(selectionInfo), {
		mode: "smart",
		audioLang: params.audioLang,
		userLanguages: params.userLanguages,
		remembered: params.remembered
	})

	return tracks[index] ?? null
}

// The series' remembered subtitle is stored as one register value: the language, plus "|f" for forced and "|h"
// for hearing impaired; null = off.
export function encodeRememberedSubtitle(track: PlayerSubtitleTrack | null): string | null {
	if (track === null) {
		return null
	}

	const lang = normalizeLanguage(track.lang) ?? "und"

	return `${lang}${track.forced ? "|f" : ""}${track.hi ? "|h" : ""}`
}

export function decodeRememberedSubtitle(value: string | null | undefined): RememberedSubtitle | "none" | null {
	if (value === undefined) {
		return null
	}

	if (value === null) {
		return "none"
	}

	const [lang = "", ...flags] = value.split("|")

	return {
		lang: lang === "und" || lang.length === 0 ? null : normalizeLanguage(lang),
		forced: flags.includes("f"),
		hi: flags.includes("h")
	}
}

// The track C brings back after subtitles were turned off: the same track when the item still has it, else one
// in the same language with the same forced and hearing-impaired flags (the next episode's sidecar). Null when
// nothing matches.
export function restoreSubtitleTrack(tracks: readonly PlayerSubtitleTrack[], last: PlayerSubtitleTrack | null): PlayerSubtitleTrack | null {
	if (last === null) {
		return null
	}

	const usable = tracks.filter(track => track.unavailable === null)
	const lang = normalizeLanguage(last.lang)

	return (
		usable.find(track => track.id === last.id) ??
		usable.find(track => normalizeLanguage(track.lang) === lang && track.forced === last.forced && track.hi === last.hi) ??
		usable.find(track => normalizeLanguage(track.lang) === lang && !track.forced) ??
		null
	)
}

// The embedded track number a choice shows, null for a sidecar or none.
export function embeddedTrackNumber(track: PlayerSubtitleTrack | null): number | null {
	if (track === null || track.external || !track.id.startsWith("e:")) {
		return null
	}

	const number = Number(track.id.slice(2))

	return Number.isSafeInteger(number) ? number : null
}

// A subtitle choice holds for the item it was made on; any other item starts from Smart.
export interface ItemSubtitleChoice {
	key: string | null
	choice: SubtitleChoice
}

export function subtitleChoiceFor(state: ItemSubtitleChoice, itemKey: string | null): SubtitleChoice {
	return state.key !== null && state.key === itemKey ? state.choice : { kind: "auto" }
}
