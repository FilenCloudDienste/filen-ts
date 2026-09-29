import type { DirColor } from "@filen/sdk-rs"
import { extensionOf, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import { DIR_COLOR_HEX, dirColorHex } from "@/features/drive/lib/dirColor"
import { fileIconKey as sharedFileIconKey, type FileIconKey, type FileIconSets } from "@filen/shared"

// The concrete file-type glyphs in src/assets/file-icons/ (byte-identical to filen-mobile's set) a
// file routes to — re-exported from @filen/shared so itemIcon.tsx and transferRow.logic.ts can keep
// importing it from here.
export type { FileIconKey }

// Routed through preview's own extension table, so a file's type icon and its preview category can
// never disagree. Camera RAW shares the plain "image" glyph deliberately: FileIconKey is an exhaustive
// Record in itemIcon.tsx keyed to the concrete SVGs in src/assets/file-icons/, so a distinct "raw" key
// would mean a new asset. A RAW file reads as an image to a user either way.
const ICON_SETS: FileIconSets = {
	isImage: ext => {
		const category = previewCategoryForExtension(ext)

		return category === "image" || category === "rawImage"
	},
	isVideo: ext => previewCategoryForExtension(ext) === "video",
	isAudio: ext => previewCategoryForExtension(ext) === "audio"
}

// Resolves a file name to its type-icon key — a thin wrapper around @filen/shared's fileIconKey so
// this app's two call sites keep passing a name rather than a pre-extracted extension. An empty name
// (an undecryptable file, no extension to read) falls through to "other".
export function fileIconKey(name: string): FileIconKey {
	return sharedFileIconKey(extensionOf(name), ICON_SETS)
}

// Darkens a hex color channel-wise (divide each channel by `divisor`, clamp to 255) — ported from
// filen-mobile's shadeColor; the folder tab uses a darker shade of the body color.
export function shadeColor(hex: string, divisor: number): string {
	const start = hex.startsWith("#") ? 1 : 0
	const channel = (offset: number): number =>
		Math.min(255, Math.round(parseInt(hex.slice(start + offset, start + offset + 2), 16) / divisor))
	const toHex = (value: number): string => value.toString(16).padStart(2, "0")

	return `#${toHex(channel(0))}${toHex(channel(2))}${toHex(channel(4))}`
}

// The two folder-glyph fills for a directory: body = the resolved DirColor hex, tab = a darker shade of
// it. The named "default" keeps filen-mobile's exact default pair (not a shade of the default body) so
// an uncolored directory reads identically across platforms.
export function directoryFolderTint(color: DirColor): { path1: string; path2: string } {
	if (color === "default") {
		return { path1: "#5398DF", path2: DIR_COLOR_HEX.default }
	}

	const hex = dirColorHex(color)

	return { path1: shadeColor(hex, 1.3), path2: hex }
}
