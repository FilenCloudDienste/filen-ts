import { hasClosest } from "@/lib/domTarget"

// What a key inside a media player landed on decides who owns it: a slider keeps its own arrows (seek, volume) and a
// button its own Space/Enter, while the player takes everything else. A menu or a text field keeps all of it
// (mediaKeys.logic.ts playerOwnsKey).
export type PlayerKeyTarget = "surface" | "button" | "slider" | "menu" | "field"

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
