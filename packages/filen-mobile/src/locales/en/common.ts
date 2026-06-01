// Truly-shared vocabulary — keys reused across multiple features. Feature catalogs
// (appearance.ts, transfers.ts, …) must NOT redefine any key declared here; the barrel
// (src/locales/en/index.ts) merges all area objects into one flat namespace and every key
// must be globally unique.
//
// Format: a flat (no nesting) `as const` object of snake_case keys → English copy, with one
// `/** JSDoc */` per key giving translator context. Comments strip at build; the `as const`
// gives full key-type-safety (see src/i18next.d.ts). i18next runs with `keySeparator:false`
// and `nsSeparator:false`, so keys are treated as opaque flat literals (dots/colons in a key
// are literal characters, not path separators).
//
// PLURAL/CONTEXT SEPARATOR RULE (Risk 1): `keySeparator:false` does NOT disable i18next's
// `pluralSeparator`/`contextSeparator`, both of which default to `_`. Because these keys are
// snake_case, a pluralized key (i18next appends `_one`/`_other`/`_male`/…) collides with the
// snake_case convention: the base key must NOT itself end in a plural/context suffix token.
// A plural key is declared as a `<base>_one`/`<base>_other` pair and called as `t("<base>", { count })`;
// no NON-plural key may end in `_one`/`_other`/`_zero`/`_two`/`_few`/`_many`/`_male`/`_female`.
// If a future base key legitimately needs such a suffix, override `pluralSeparator`/
// `contextSeparator` to a snake-safe value (e.g. `"__"`) in src/lib/i18n.ts.
//
// Native language names (English, Deutsch, …) do NOT live here — they are non-translated
// constants in src/lib/language.ts.
export const common = {
	/** Generic confirm/destructive action button: reset */
	reset: "Reset",
	/** Generic dialog cancel button */
	cancel: "Cancel",
	/** Generic action-sheet dismiss button */
	close: "Close"
} as const
