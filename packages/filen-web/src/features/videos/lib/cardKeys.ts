import { isImeKeydown, matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { VIDEOS_CARD_ACTIONS } from "@/features/videos/lib/keymap"
import type { VideoCardAction } from "@/features/videos/components/videoCard"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"

// The commands a focused video card takes from the keyboard (the grid, the home rows, search), by registered action.
export type VideoCardCommand = "play" | "toggleWatched" | "hide"

const COMMANDS: Readonly<Record<(typeof VIDEOS_CARD_ACTIONS)[number]["id"], VideoCardCommand>> = {
	"videos.play": "play",
	"videos.toggleWatched": "toggleWatched",
	"videos.hide": "hide"
}

// The card command a keydown on a card is, under `combos` (the combos in effect by action id, useBindings), or null.
export function cardCommand(
	event: ChordEvent & { readonly isComposing?: boolean; readonly keyCode?: number },
	combos: Readonly<Record<string, string>>,
	mac: boolean
): VideoCardCommand | null {
	if (isImeKeydown(event)) {
		return null
	}

	for (const def of VIDEOS_CARD_ACTIONS) {
		if (matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac)) {
			return COMMANDS[def.id]
		}
	}

	return null
}

// What a command does to `card`, as its menu would: null where the menu has no such item for it.
export function cardCommandAction(
	command: VideoCardCommand,
	card: Pick<VideoCardModel, "play" | "unsupported" | "badge" | "hideable">
): VideoCardAction | null {
	switch (command) {
		case "play":
			return card.play === null ? null : "play"
		case "toggleWatched":
			return card.unsupported ? null : card.badge?.kind === "watched" ? "markUnwatched" : "markWatched"
		case "hide":
			return card.hideable ? "hide" : null
	}
}
