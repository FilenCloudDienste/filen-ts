import type { DirColor } from "@filen/sdk-rs"

// The six named directory colors mapped to the same hex values filen-mobile's directoryColorToHex
// uses, so a directory's tint reads identically on both platforms. Sourced once here and consumed by
// the color dialog's swatches and the info dialog's hero tile alike.
export const DIR_COLOR_HEX: Record<"default" | "blue" | "green" | "purple" | "red" | "gray", string> = {
	default: "#85BCFF",
	blue: "#037AFF",
	green: "#33C759",
	purple: "#AF52DE",
	red: "#FF3B30",
	gray: "#8F8E93"
}

const HEX_PATTERN = /^#[0-9a-f]{6}$/i

// Resolves any DirColor to a concrete hex: a named color maps through DIR_COLOR_HEX, a freeform
// "#rrggbb" (the SDK's custom-color arm) passes through untouched, and anything unrecognized falls
// back to the default tint — the row/tile always has a real color to paint with.
export function dirColorHex(color: DirColor): string {
	if (color === "default" || color === "blue" || color === "green" || color === "purple" || color === "red" || color === "gray") {
		return DIR_COLOR_HEX[color]
	}

	return HEX_PATTERN.test(color) ? color : DIR_COLOR_HEX.default
}

// Normalizes free-typed hex input for the color dialog's custom-color field: accepts with or without
// a leading "#", requires exactly 6 hex digits, returns a canonical lowercase "#rrggbb" or null when
// the input isn't (yet) a complete, valid hex — the caller's Apply control stays disabled on null
// rather than ever sending a malformed DirColor string to the SDK.
export function normalizeCustomHex(value: string): string | null {
	const digits = value.trim().replace(/^#/, "")

	return HEX_PATTERN.test(`#${digits}`) ? `#${digits.toLowerCase()}` : null
}

// True when a DirColor is the SDK's freeform custom arm rather than one of the six named colors —
// the color dialog uses this to decide whether the custom swatch (not one of the fixed six) should
// show as currently selected.
export function isCustomDirColor(color: DirColor): boolean {
	return color !== "default" && color !== "blue" && color !== "green" && color !== "purple" && color !== "red" && color !== "gray"
}
