import type { DirColor } from "@filen/sdk-rs"
import { DIR_COLOR_HEX, isNamedDirColor, isValidHexColor } from "@filen/shared"

// The custom-color picker's starting value: `<input type=color>` only accepts lowercase hex.
export const DEFAULT_CUSTOM_HEX = DIR_COLOR_HEX.default.toLowerCase()

// Normalizes free-typed hex input for the color dialog's custom-color field: accepts with or without
// a leading "#", requires exactly 6 hex digits, returns a canonical lowercase "#rrggbb" or null when
// the input isn't (yet) a complete, valid hex — the caller's Apply control stays disabled on null
// rather than ever sending a malformed DirColor string to the SDK.
export function normalizeCustomHex(value: string): string | null {
	const hex = `#${value.trim().replace(/^#/, "")}`

	return isValidHexColor(hex) ? hex.toLowerCase() : null
}

// True when a DirColor is the SDK's freeform custom arm rather than one of the six named colors —
// the color dialog uses this to decide whether the custom swatch (not one of the fixed six) should
// show as currently selected.
export function isCustomDirColor(color: DirColor): boolean {
	return !isNamedDirColor(color)
}
