import { fileTypeKind, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import { fileIconKey as sharedFileIconKey, type FileVerdict, type FileIconKey, type FileIconSets } from "@filen/shared"

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
// shows the text glyph, an extensionless upload its mime's, a `.ts` read as a transport stream the video
// glyph). `mime` is absent where none is stored (a transfer row), `uuid` where the file has none yet;
// `verdict` as fileTypeExtension takes it. An empty name (an undecryptable file) falls through to "other".
// A `.key` shows Keynote's glyph only once a read found the package.
export function fileIconKey(name: string, mime?: string | null, uuid?: string, verdict?: FileVerdict): FileIconKey {
	const { extension, kind, source } = fileTypeKind(name, mime, uuid, verdict)
	const key = sharedFileIconKey(extension, ICON_SETS, source === "sniff" && kind !== null)

	// Code extensions only this app's table adds (`.mts`, `.cts`).
	return key === "other" && previewCategoryForExtension(extension) === "code" ? "code" : key
}
