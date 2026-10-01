import { fileTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
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

// Resolves a file to its type-icon key by the same type extension its preview category reads (a LICENSE
// shows the text glyph, an extensionless upload its mime's). `mime` is absent where none is stored (a
// transfer row). An empty name (an undecryptable file) falls through to "other".
export function fileIconKey(name: string, mime?: string | null): FileIconKey {
	return sharedFileIconKey(fileTypeExtension(name, mime), ICON_SETS)
}
