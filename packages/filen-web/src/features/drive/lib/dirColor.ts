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
