import { isValidHexColor } from "./misc"

// The named directory colors; every client paints them with these exact hexes.
export const DIR_COLOR_HEX = {
	default: "#85BCFF",
	blue: "#037AFF",
	green: "#33C759",
	purple: "#AF52DE",
	red: "#FF3B30",
	gray: "#8F8E93"
} as const

export type NamedDirColor = keyof typeof DIR_COLOR_HEX

export type FolderTint = Readonly<{
	// Tab
	path1: string
	// Body
	path2: string
}>

// Not a shade of the default body: the historical default pair
const DEFAULT_FOLDER_TINT: FolderTint = { path1: "#5398DF", path2: DIR_COLOR_HEX.default }

export function isNamedDirColor(color: string): color is NamedDirColor {
	return Object.hasOwn(DIR_COLOR_HEX, color)
}

// A named color maps through DIR_COLOR_HEX and a custom "#rrggbb" passes through as-is (case kept);
// anything missing or malformed resolves to the default.
export function dirColorHex(color: string | null | undefined): string {
	if (!color) {
		return DIR_COLOR_HEX.default
	}

	if (isNamedDirColor(color)) {
		return DIR_COLOR_HEX[color]
	}

	return isValidHexColor(color) ? color : DIR_COLOR_HEX.default
}

// Each channel of a "#rrggbb" divided by 1.3, so it never exceeds ff
function tabShade(hex: string): string {
	const channel = (offset: number): string =>
		Math.round(parseInt(hex.slice(offset, offset + 2), 16) / 1.3)
			.toString(16)
			.padStart(2, "0")

	return `#${channel(1)}${channel(3)}${channel(5)}`
}

// The folder glyph's two fills: body = the resolved color, tab = a darker shade of it.
export function directoryFolderTint(color: string | null | undefined): FolderTint {
	if (!color || color === "default") {
		return DEFAULT_FOLDER_TINT
	}

	const hex = dirColorHex(color)

	return { path1: tabShade(hex), path2: hex }
}
