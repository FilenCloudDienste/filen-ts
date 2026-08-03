// react-hotkeys-hook treats a comma-separated combo as ALTERNATIVES ("delete,backspace" = either
// key) and a "+"-separated one as a chord. Tokens come back lowercased and trimmed, matching the
// library's own parse (it lowercases the whole combo before splitting), so the result is directly
// comparable — this is the single source of truth for both rendering a combo and detecting that two
// combos would fire on the same keypress (lib/keymap/conflicts.ts).
export function comboAlternatives(combo: string): string[][] {
	return combo
		.toLowerCase()
		.split(",")
		.map(alternative =>
			alternative
				.split("+")
				.map(key => key.trim())
				.filter(key => key.length > 0)
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
