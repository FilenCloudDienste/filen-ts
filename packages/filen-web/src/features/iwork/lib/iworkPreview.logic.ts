// Apple iWork documents: a Pages, Numbers or Keynote file is a zip package whose content only its app renders, but which
// carries a rendering of itself the preview shows instead.

// The app each iWork extension belongs to, by name (a product name, never translated).
export const IWORK_APPS: ReadonlyMap<string, string> = new Map([
	["pages", "Pages"],
	["numbers", "Numbers"],
	["key", "Keynote"]
])

export const IWORK_EXTENSIONS: readonly string[] = [...IWORK_APPS.keys()]

export type IworkPreviewKind = "pdf" | "image"

export interface IworkPreviewPath {
	readonly path: string
	readonly kind: IworkPreviewKind
}

// Where each package generation keeps its rendering, best first: '09 packages a PDF of the document (and a thumbnail),
// '13 and later images of the first page at three sizes.
export const IWORK_PREVIEW_PATHS: readonly IworkPreviewPath[] = [
	{ path: "QuickLook/Preview.pdf", kind: "pdf" },
	{ path: "preview.jpg", kind: "image" },
	{ path: "preview-web.jpg", kind: "image" },
	{ path: "QuickLook/Thumbnail.jpg", kind: "image" },
	{ path: "preview-micro.jpg", kind: "image" }
]

export interface IworkPreviewPick<T> {
	readonly found: T
	readonly kind: IworkPreviewKind
}

// The first rendering the package holds (`find`: the entry at a path, null when absent); null when it holds none.
export function pickIworkPreview<T>(find: (path: string) => T | null): IworkPreviewPick<T> | null {
	for (const { path, kind } of IWORK_PREVIEW_PATHS) {
		const found = find(path)

		if (found !== null) {
			return { found, kind }
		}
	}

	return null
}

// The app a document of `extension` opens in; null for no iWork extension.
export function iworkAppFor(extension: string): string | null {
	return IWORK_APPS.get(extension) ?? null
}

// A listing failure that says the file is no package the preview can read (not a zip, damaged, encrypted): it has no
// preview to show, which no retry changes.
const UNREADABLE_PACKAGE_KINDS: ReadonlySet<string> = new Set([
	"ArchiveUnsupported",
	"ArchiveCorrupt",
	"ArchiveTooLarge",
	"ArchivePasswordRequired",
	"ArchiveWrongPassword"
])

export function isUnreadablePackage(kind: string | undefined): boolean {
	return kind !== undefined && UNREADABLE_PACKAGE_KINDS.has(kind)
}
