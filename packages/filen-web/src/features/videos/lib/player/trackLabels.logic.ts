import type { TFunction } from "i18next"
import { languageName, type ProbeAudio } from "@filen/shared/videos"
import type { PlayerSubtitleTrack } from "@/features/videos/lib/player/subtitles.logic"

// Track names shared by the player's tracks menu, its track notices and the detail pages' selects.

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
	return [languageName(track.lang) ?? t("playerTrackNumber", { number: index + 1 }), channelLabel(track.ch, key => t(key))]
		.filter(part => part !== null)
		.join(" ")
}

// A subtitle track as the tracks menu names it: its language, forced and SDH marked ("German · Forced").
export function subtitleTrackName(track: Pick<PlayerSubtitleTrack, "lang" | "forced" | "hi">, t: TFunction<"videos">): string {
	const parts = [languageName(track.lang) ?? t("subtitleUnknownLanguage")]

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
