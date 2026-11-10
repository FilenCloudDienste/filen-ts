import { matchesCombo, typedWithAltGraph, type ChordEvent } from "@filen/shared/keymap"

// The browser's own page-zoom keys, which it reads by CHARACTER: Mod with "+" or "=" zooms in, with "-" out, with "0"
// resets, wherever the layout puts those characters (a German keyboard's "+" key is BracketRight, its "-" Slash). A
// document viewer that zooms its document in their place (the PDF viewer, the presentation editor) takes them as a
// fixed key ahead of its default bindings, which match by physical key like every shortcut (@filen/shared/keymap):
// otherwise those layouts would zoom the whole page, or run the default that holds that key's US position. A key the
// user bound to an action (matchesOverride) stays that action.
export type BrowserZoomKey = "in" | "out" | "reset"

export function browserZoomKey(event: ChordEvent, mac: boolean): BrowserZoomKey | undefined {
	if (event.altKey || event.ctrlKey !== !mac || event.metaKey !== mac || typedWithAltGraph(event, mac)) {
		return undefined
	}

	switch (event.key) {
		case "+":
		case "=":
			return "in"
		case "-":
			return "out"
		case "0":
			return event.shiftKey ? undefined : "reset"
		default:
			return undefined
	}
}

// Whether `event` is the user's own binding `override` (undefined: the action keeps its default).
export function matchesOverride(event: ChordEvent, override: string | undefined, mac: boolean): boolean {
	return override !== undefined && matchesCombo(event, override, mac)
}
