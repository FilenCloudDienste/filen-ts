import type { TFunction } from "i18next"
import { fnv1a } from "@/lib/fnv1a"
import type { CardSubline, VideoCardModel } from "@/features/videos/lib/homeRows.logic"

// Card text and colour that need no DOM: the title-set card's tone, the episode code and the link's accessible name.

// Neutral oklch lightness steps the title-set card picks from: every one dark enough for white text (≥ 4.5:1).
const NEUTRAL_LIGHTNESS = [0.3, 0.34, 0.38, 0.42, 0.46] as const

// A neutral grey, stable per title.
export function neutralTone(title: string): string {
	return `oklch(${String(NEUTRAL_LIGHTNESS[fnv1a(title) % NEUTRAL_LIGHTNESS.length] ?? 0.38)} 0 0)`
}

// "S2E5", "S1E1-E2" for a multi-episode file; empty for an unnumbered episode.
export function episodeCode({ season, episode, episodeEnd }: { season: number; episode: number; episodeEnd: number }): string {
	if (episode <= 0) {
		return ""
	}

	const start = `S${String(season)}E${String(episode)}`

	return episodeEnd > episode ? `${start}-E${String(episodeEnd)}` : start
}

export function sublineText(subline: CardSubline, t: TFunction<"videos">): string {
	switch (subline.kind) {
		case "year":
			return String(subline.year)
		case "episode": {
			const code = episodeCode(subline)

			return code.length === 0
				? subline.title
				: subline.title.length === 0
					? code
					: t("videosCardEpisodeTitled", { code, title: subline.title })
		}
		case "remaining":
			return t("videosCardMinutesLeft", { count: Math.max(1, Math.round(subline.seconds / 60)) })
		case "upNext":
			return t("videosCardUpNext")
		case "season":
			return t("videosCardSeasonNew", { season: subline.season, count: subline.count })
		case "newEpisodes":
			return t("videosCardNewEpisodes", { count: subline.count })
		case "unsupported":
			return t("videosCardUnsupported", { container: subline.container.toUpperCase() })
	}
}

// The heading a card shows: the series' title over an episode, else the title's.
export function cardHeading(card: Pick<VideoCardModel, "title">): string {
	return card.title.title
}

// "Title, year, 45% watched", with what the badges say and whether it plays here.
export function cardLabel(card: VideoCardModel, t: TFunction<"videos">): string {
	const parts = [cardHeading(card), ...card.sublines.map(subline => sublineText(subline, t))]

	if (card.progress !== null && !card.sublines.some(subline => subline.kind === "remaining")) {
		parts.push(t("videosCardPercentWatched", { fraction: Math.round(card.progress * 100) / 100 }))
	}

	if (card.badge?.kind === "unwatched") {
		parts.push(t("videosCardUnwatchedCount", { count: card.badge.count }))
	} else if (card.badge?.kind === "watched") {
		parts.push(t("videosCardWatched"))
	}

	if (card.unsupported) {
		parts.push(t("videosCardNotPlayableLabel"))
	}

	return t("videosCardLabel", { parts: parts.filter(part => part.length > 0) })
}
