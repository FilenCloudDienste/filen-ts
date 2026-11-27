import type { DirColor } from "@filen/sdk-rs"
import type { DriveKey } from "@/lib/i18n"
import { DIR_COLOR_HEX, isNamedDirColor, isValidHexColor } from "@filen/shared"

// The custom-color picker's starting value.
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

export interface DirColorSwatch {
	// Stored as-is: a named color, or a lowercase "#rrggbb" custom value.
	value: DirColor
	labelKey: DriveKey
}

// The named six keep their stored values (every client matches them); the rest are plain custom hexes.
export const DIR_COLOR_SWATCHES: readonly DirColorSwatch[] = [
	{ value: "default", labelKey: "driveColorDefault" },
	{ value: "blue", labelKey: "driveColorBlue" },
	{ value: "green", labelKey: "driveColorGreen" },
	{ value: "purple", labelKey: "driveColorPurple" },
	{ value: "red", labelKey: "driveColorRed" },
	{ value: "gray", labelKey: "driveColorGray" },
	{ value: "#ff9500", labelKey: "driveColorOrange" },
	{ value: "#ffcc00", labelKey: "driveColorYellow" },
	{ value: "#a4d61e", labelKey: "driveColorLime" },
	{ value: "#00c7be", labelKey: "driveColorMint" },
	{ value: "#30b0c7", labelKey: "driveColorTeal" },
	{ value: "#32ade6", labelKey: "driveColorCyan" },
	{ value: "#5856d6", labelKey: "driveColorIndigo" },
	{ value: "#ff2d55", labelKey: "driveColorPink" },
	{ value: "#a2845e", labelKey: "driveColorBrown" },
	{ value: "#8b1e3f", labelKey: "driveColorMaroon" },
	{ value: "#5b6b7f", labelKey: "driveColorSlate" }
]

const SWATCH_VALUES: ReadonlySet<string> = new Set(DIR_COLOR_SWATCHES.map(swatch => swatch.value))

// The radio value a directory's stored color selects: named colors as-is, custom hexes lowercased.
export function dirColorRadioValue(color: DirColor): string {
	return isNamedDirColor(color) ? color : color.toLowerCase()
}

export const MAX_RECENT_DIR_COLORS = 5

// Most-recent-first, deduplicated, capped; a curated swatch is never a "recent".
export function withRecentDirColor(recent: readonly string[], hex: string): string[] {
	if (SWATCH_VALUES.has(hex)) {
		return recent.slice()
	}

	return [hex, ...recent.filter(each => each !== hex)].slice(0, MAX_RECENT_DIR_COLORS)
}
