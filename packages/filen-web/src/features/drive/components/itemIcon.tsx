import type { DirColor } from "@filen/sdk-rs"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { directoryFolderTint, fileIconKey, type FileIconKey } from "@/features/drive/lib/icon.logic"
import { cn } from "@/lib/utils"
import imageUrl from "@/assets/file-icons/image.svg"
import videoUrl from "@/assets/file-icons/video.svg"
import audioUrl from "@/assets/file-icons/audio.svg"
import pdfUrl from "@/assets/file-icons/pdf.svg"
import txtUrl from "@/assets/file-icons/txt.svg"
import docUrl from "@/assets/file-icons/doc.svg"
import pptUrl from "@/assets/file-icons/ppt.svg"
import xlsUrl from "@/assets/file-icons/xls.svg"
import codeUrl from "@/assets/file-icons/code.svg"
import archiveUrl from "@/assets/file-icons/archive.svg"
import exeUrl from "@/assets/file-icons/exe.svg"
import isoUrl from "@/assets/file-icons/iso.svg"
import cadUrl from "@/assets/file-icons/cad.svg"
import psdUrl from "@/assets/file-icons/psd.svg"
import androidUrl from "@/assets/file-icons/android.svg"
import appleUrl from "@/assets/file-icons/apple.svg"
import otherUrl from "@/assets/file-icons/other.svg"

// Vite resolves each import to a same-origin asset URL (CSP img-src 'self'). The glyphs carry their
// own baked colors and are designed to read on both themes.
const FILE_ICON_URL: Record<FileIconKey, string> = {
	image: imageUrl,
	video: videoUrl,
	audio: audioUrl,
	pdf: pdfUrl,
	txt: txtUrl,
	doc: docUrl,
	ppt: pptUrl,
	xls: xlsUrl,
	code: codeUrl,
	archive: archiveUrl,
	exe: exeUrl,
	iso: isoUrl,
	cad: cadUrl,
	psd: psdUrl,
	android: androidUrl,
	apple: appleUrl,
	other: otherUrl
}

// The folder viewBox and its two path shapes are folder.svg inlined: an <img src> can't be recolored,
// so the glyph is drawn inline to tint its two fills by a directory's own color at render time. Both
// fills are opaque brand colors, identical on light and dark.
const FOLDER_VIEWBOX = "0 0 1228 1024"
const FOLDER_TAB_PATH =
	"M1197,212.6v540.1c0,39.6-34.5,71.4-76.8,71.4h-797c-51.8,0-88.7-46.8-73.3-92.8l126.7-375.8H70.4 C31.7,355.4,0,326.5,0,291.1V98.4C0,63,31.7,34.1,70.4,34.1h378.8c26.7,0,51,13.9,63,35.7l39,71.4h569 C1162.5,141.2,1197.1,173.3,1197,212.6"
const FOLDER_BODY_PATH =
	"M1128.7,997.9H68.3C30.6,997.9,0,967.3,0,929.6V280.4c0-37.7,30.6-68.3,68.3-68.3h1060.5 c37.7,0,68.3,30.6,68.3,68.3v0v649.2C1197,967.3,1166.4,997.9,1128.7,997.9"

// A folder glyph tinted by a directory's color. The default/uncolored case reuses filen-mobile's exact
// default pair. `className` sizes the box (the glyph scales to fit, letterboxed to its wider aspect).
export function DirectoryGlyph({ color, className }: { color: DirColor; className?: string | undefined }) {
	const tint = directoryFolderTint(color)

	return (
		<svg
			aria-hidden="true"
			viewBox={FOLDER_VIEWBOX}
			className={className}
		>
			<path
				d={FOLDER_TAB_PATH}
				fill={tint.path1}
			/>
			<path
				d={FOLDER_BODY_PATH}
				fill={tint.path2}
			/>
		</svg>
	)
}

// A file's concrete type-icon asset (decorative — alt="" and aria-hidden). object-contain preserves the
// glyph's own aspect within whatever square `className` sizes. Exported (not ItemIcon-only-internal)
// so a caller with just a file NAME — no full DriveItem to hand ItemIcon below — can still render the
// exact same glyph set; transferRow.tsx's leading type-icon (a transfer row has no DriveItem, only the
// name/size the store carries) is the first such caller.
export function FileTypeIcon({ iconKey, className }: { iconKey: FileIconKey; className?: string | undefined }) {
	return (
		<img
			src={FILE_ICON_URL[iconKey]}
			alt=""
			aria-hidden="true"
			draggable={false}
			decoding="async"
			className={cn("object-contain", className)}
		/>
	)
}

// A drive item's icon: a directory to a folder glyph tinted by its own color (a shared directory reads
// as the neutral default, mirroring the info hero), a file to its type-icon asset. An undecryptable
// file has no name to route on and falls to the generic "other" glyph.
export function ItemIcon({ item, className }: { item: DriveItem; className?: string | undefined }) {
	const base = asDirectoryOrFile(item)

	if (base.type === "directory") {
		return (
			<DirectoryGlyph
				color={item.type === "directory" ? item.data.color : "default"}
				className={className}
			/>
		)
	}

	return (
		<FileTypeIcon
			iconKey={fileIconKey(base.data.decryptedMeta?.name ?? "")}
			className={className}
		/>
	)
}
