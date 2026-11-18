import i18n, { type TFunction } from "i18next"
import { languageName, normalizeLanguage, type ProbeAudio } from "@filen/shared/videos"
import type { PlayerSubtitleTrack } from "@/features/videos/lib/player/subtitles.logic"
import { languageDisplayNames } from "@/lib/i18n/languageNames"

// Track names shared by the player's tracks menu, its track notices and the detail pages' selects.

// A track's language code ("ger", "deu", "de") named in the UI language ("Deutsch" in German); the English name where
// the platform names none, null when the code is unknown or undetermined.
export function trackLanguageName(code: string | null | undefined, uiLanguage: string): string | null {
	const tag = normalizeLanguage(code)

	if (tag === null) {
		return null
	}

	let name: string | undefined

	try {
		name = languageDisplayNames(uiLanguage)?.of(tag)
	} catch {
		name = undefined
	}

	return name === undefined || name === tag ? languageName(tag) : name
}

export function channelLabel(channels: number | null, t: (key: "playerChannelsMono" | "playerChannelsStereo") => string): string | null {
	switch (channels) {
		case null:
			return null
		case 1:
			return t("playerChannelsMono")
		case 2:
			return t("playerChannelsStereo")
		case 6:
			return "5.1"
		case 8:
			return "7.1"
		default:
			return `${String(channels)} ch`
	}
}

// An audio track as the tracks menu names it: its language (else its number) and channels ("English 5.1").
export function audioTrackName(track: Pick<ProbeAudio, "lang" | "ch">, index: number, t: TFunction<"videos">): string {
	return [
		trackLanguageName(track.lang, i18n.language) ?? t("playerTrackNumber", { number: index + 1 }),
		channelLabel(track.ch, key => t(key))
	]
		.filter(part => part !== null)
		.join(" ")
}

const CODEC_NAMES: Readonly<Record<string, string>> = {
	aac: "AAC",
	mp3: "MP3",
	ac3: "Dolby Digital",
	eac3: "Dolby Digital Plus",
	dts: "DTS",
	truehd: "TrueHD",
	opus: "Opus",
	vorbis: "Vorbis",
	flac: "FLAC",
	alac: "ALAC"
}

// An audio track's second line in a tracks menu: commentary, its own title, its codec ("Director · Dolby Digital").
export function audioTrackDetail(track: Pick<ProbeAudio, "commentary" | "name" | "codec">, t: TFunction<"videos">): string | null {
	const details = [
		track.commentary ? t("playerAudioCommentary") : null,
		track.name,
		track.codec === null ? null : (CODEC_NAMES[track.codec] ?? null)
	].filter((part): part is string => part !== null && part.length > 0)

	return details.length === 0 ? null : [...new Set(details)].join(" · ")
}

// A subtitle track as the tracks menu names it: its language, forced and SDH marked ("German · Forced").
export function subtitleTrackName(track: Pick<PlayerSubtitleTrack, "lang" | "forced" | "hi">, t: TFunction<"videos">): string {
	const parts = [trackLanguageName(track.lang, i18n.language) ?? t("subtitleUnknownLanguage")]

	if (track.forced) {
		parts.push(t("subtitleForced"))
	}

	if (track.hi) {
		parts.push(t("subtitleSdh"))
	}

	return parts.join(" · ")
}

// The player's notice after its keys switch the subtitles: the track now shown, or off (null).
export function subtitleTrackNotice(track: Pick<PlayerSubtitleTrack, "lang" | "forced" | "hi"> | null, t: TFunction<"videos">): string {
	return track === null ? t("playerSubtitlesOffNotice") : t("playerSubtitleTrackNotice", { track: subtitleTrackName(track, t) })
}

// The player's notice after its key switches the audio to the track at `index`.
export function audioTrackNotice(track: Pick<ProbeAudio, "lang" | "ch">, index: number, t: TFunction<"videos">): string {
	return t("playerAudioTrackNotice", { track: audioTrackName(track, index, t) })
}
