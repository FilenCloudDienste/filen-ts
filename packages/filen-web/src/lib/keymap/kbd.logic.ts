// Spellings react-hotkeys-hook rewrites to a canonical token BEFORE it matches an event, mirroring the
// library's own alias map. Two combos written differently ("mod+shift+right" and "mod+shift+arrowright")
// therefore fire on the very same keypress, so comparing raw tokens would miss the collision. The
// library's code-side entries (ShiftLeft, ControlRight, …) are deliberately absent: they only ever apply
// to an `event.code`, and the recorder hands us tokens it has already mapped through them.
const KEY_ALIASES: Record<string, string> = {
	esc: "escape",
	return: "enter",
	left: "arrowleft",
	right: "arrowright",
	up: "arrowup",
	down: "arrowdown"
}

// react-hotkeys-hook treats a comma-separated combo as ALTERNATIVES ("delete,backspace" = either
// key) and a "+"-separated one as a chord. Tokens come back lowercased, trimmed and alias-resolved,
// matching the library's own parse (it lowercases the whole combo before splitting and maps every token
// through its alias table), so the result is directly comparable — this is the single source of truth
// for both rendering a combo and detecting that two combos would fire on the same keypress
// (lib/keymap/conflicts.ts).
export function comboAlternatives(combo: string): string[][] {
	return combo
		.toLowerCase()
		.split(",")
		.map(alternative =>
			alternative
				.split("+")
				.map(key => key.trim())
				.filter(key => key.length > 0)
				.map(key => KEY_ALIASES[key] ?? key)
		)
		.filter(keys => keys.length > 0)
}

// The app's ONE mac predicate, replicating react-hotkeys-hook's own (module-private there) verbatim.
// It is what decides whether `mod` matches Meta or Control, so the glyph a user sees, the token the
// combo recorder folds to `mod`, and the key the library actually matches can never disagree — a
// second predicate over the deprecated `navigator.platform` would silently save bindings that never
// fire on the clients where the two differ.
export function isMacPlatform(): boolean {
	return typeof navigator === "undefined" ? false : /mac/i.test(navigator.userAgent) && !/iphone|ipad|ipod/i.test(navigator.userAgent)
}
