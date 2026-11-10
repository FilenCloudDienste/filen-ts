// The app's ONE mac predicate is react-hotkeys-hook's own, kept in @filen/shared/keymap so the office editors read
// the same one: it decides whether `mod` matches Meta or Control, so the glyph a user sees, the token the recorder
// folds to `mod` and the key the library matches can never disagree.
export { isMacPlatform } from "@filen/shared/keymap"
