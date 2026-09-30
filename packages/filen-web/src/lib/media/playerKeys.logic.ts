import { hasClosest } from "@/lib/domTarget"
import { SEEK_STEP_SECONDS } from "@/lib/media/scrubber.logic"

// A media player's keyboard, for keys pressed while focus is inside it. The player owns these only
// there: outside, the same arrows belong to whatever hosts it (the preview overlay's pager).

export const VOLUME_STEP = 0.05

export type PlayerKeyAction =
	| { type: "togglePlay" }
	| { type: "seekBy"; seconds: number }
	| { type: "volumeBy"; delta: number }
	| { type: "toggleMute" }
	| { type: "toggleFullscreen" }

// What the key landed on decides who owns it: a slider keeps its own arrows (seek, volume) and a button
// its own Space/Enter, while the player takes everything else. A menu or a text field keeps all of it.
export type PlayerKeyTarget = "surface" | "button" | "slider" | "menu" | "field"

export interface PlayerKeyInput {
	key: string
	target: PlayerKeyTarget
	modified: boolean
	fullscreen: boolean
}

export function playerKeyAction({ key, target, modified, fullscreen }: PlayerKeyInput): PlayerKeyAction | null {
	// Chords stay the browser's and the app's shortcuts.
	if (modified || target === "menu" || target === "field") {
		return null
	}

	switch (key.length === 1 ? key.toLowerCase() : key) {
		case " ":
			return target === "button" ? null : { type: "togglePlay" }
		case "k":
			return { type: "togglePlay" }
		case "m":
			return { type: "toggleMute" }
		case "f":
			return fullscreen ? { type: "toggleFullscreen" } : null
		case "ArrowLeft":
			return target === "slider" ? null : { type: "seekBy", seconds: -SEEK_STEP_SECONDS }
		case "ArrowRight":
			return target === "slider" ? null : { type: "seekBy", seconds: SEEK_STEP_SECONDS }
		case "ArrowUp":
			return target === "slider" ? null : { type: "volumeBy", delta: VOLUME_STEP }
		case "ArrowDown":
			return target === "slider" ? null : { type: "volumeBy", delta: -VOLUME_STEP }
		default:
			return null
	}
}

// Classifies a keydown target inside the player. Probed by shape (hasClosest), so node tests can drive it.
export function playerKeyTarget(target: EventTarget | null): PlayerKeyTarget {
	if (!hasClosest(target)) {
		return "surface"
	}

	if (target.closest("[role='menu'], [role='menuitem'], [role='menuitemradio']") !== null) {
		return "menu"
	}

	if (target.closest("input[type='range'], [role='slider']") !== null) {
		return "slider"
	}

	if (target.closest("input, textarea, select, [contenteditable='true']") !== null) {
		return "field"
	}

	if (target.closest("button, a, [role='button']") !== null) {
		return "button"
	}

	return "surface"
}
