import type {
	DocNotConvertedKind,
	DocxAnnotations,
	DocxConvertedDocument,
	DocxEncryptionRefusal,
	DocxLegacyRefusal,
	DocxErrorReason,
	DocxMarkupInfo,
	DocxMarkupMode,
	DocxOpenInfo,
	DocxRevisionTarget,
	DocxUnlockedDocument,
	DocxViewerCommand,
	DocxViewerState
} from "@filen/office/dom/docx"
import type { DocxDocument } from "@filen/office/react/docx"
import { isCompoundFile } from "@filen/office/core/cfb"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { extensionOf, itemFileKind } from "@/features/drive/lib/preview.logic"
import type { PreviewKey } from "@/lib/i18n"
import type { ZoomFit } from "@/features/preview/components/commandBar.logic"

// A `.dot` is a Word 97–2003 template or a text file (Graphviz) under the same extension: bytes that are neither a
// compound file nor a zip package are text.
export function isTextTemplate(item: DriveItem, bytes: Uint8Array): boolean {
	const kind = itemFileKind(item)
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b

	return kind?.ambiguous === true && kind.extension === "dot" && !zip && !isCompoundFile(bytes)
}

// Which engine failures fall back to docx-preview for this release: the engine throwing (a defect or a
// limit it hit) or rejecting markup docx-preview may still read. Files that are not a readable Word
// document at all (encrypted, legacy .doc, not a zip) fail the same way in both and get a message instead.
const FALLBACK_REASONS: ReadonlySet<DocxErrorReason> = new Set<DocxErrorReason>(["failed", "malformed", "invalidPackage"])

// docx-preview renders the whole document on the main thread at once: past these sizes it freezes the tab
// for many seconds and takes gigabytes (a 131 MB document.xml: 37 s, 6.6 GB), so the error shows instead.
// The main part's uncompressed size when the engine read the zip directory, else the file's own size.
export const FALLBACK_MAX_MAIN_PART_BYTES = 24 * 1024 * 1024
export const FALLBACK_MAX_FILE_BYTES = 8 * 1024 * 1024

// The zoom menu's steps (percent) and fits, in the viewer and the editor alike.
export const DOCX_ZOOM_PRESETS: readonly number[] = [50, 75, 100, 125, 150, 200, 300, 400]
export const DOCX_ZOOM_FITS: readonly ZoomFit[] = ["fitWidth"]

export type DocxFailure = { readonly fallback: boolean; readonly detail: string } | null

export function docxFailure(document: DocxDocument, fileBytes: number): DocxFailure {
	const error = document.error

	if (document.status !== "error" || error === undefined || !FALLBACK_REASONS.has(error.reason)) {
		return null
	}

	const size = error.mainPartBytes
	const fallback = size === undefined ? fileBytes <= FALLBACK_MAX_FILE_BYTES : size <= FALLBACK_MAX_MAIN_PART_BYTES

	return { fallback, detail: `${error.reason}: ${error.message} (main part ${size === undefined ? "unknown" : String(size)} bytes)` }
}

export type DocxErrorKey =
	| "previewDocxNeedsPassword"
	| "previewDocxRightsManaged"
	| "previewDocxUnsupportedEncryption"
	| "previewDocxDamagedEncryption"
	| "previewDocxLegacyFormat"
	| "previewDocxNotDocument"
	| "previewDocxLoadFailed"

export function docxErrorKey(reason: DocxErrorReason | undefined): DocxErrorKey {
	switch (reason) {
		// The viewer unlocks a password-protected file before the engine opens it: the engine meets one only
		// when that was not done (the file then needs the preview opened again).
		case "needsPassword":
			return "previewDocxNeedsPassword"
		case "rightsManaged":
			return "previewDocxRightsManaged"
		case "unsupportedEncryption":
			return "previewDocxUnsupportedEncryption"
		case "damagedEncryption":
			return "previewDocxDamagedEncryption"
		case "legacyBinary":
			return "previewDocxLegacyFormat"
		case "notWordprocessing":
		case "compoundFile":
		case "notZip":
			return "previewDocxNotDocument"
		default:
			return "previewDocxLoadFailed"
	}
}

// Why an encrypted document is not opened, before any password is asked.
export function docxRefusalKey(reason: DocxEncryptionRefusal): DocxErrorKey {
	switch (reason) {
		case "rightsManaged":
			return "previewDocxRightsManaged"
		case "unsupported":
			return "previewDocxUnsupportedEncryption"
		case "damaged":
			return "previewDocxDamagedEncryption"
	}
}

// A Word 97–2003 document with a password to open in a scheme the worker decrypts ([MS-DOC] §2.2.6): the password is
// asked, then the file converted with it.
export function legacyNeedsPassword(refusal: DocxLegacyRefusal): boolean {
	return refusal.reason === "encrypted" && refusal.encryption !== undefined && refusal.encryption !== "unknown"
}

// Why a Word 97–2003 document is not shown: Word 6/95 files are refused, and encrypted ones the worker cannot decrypt;
// anything else is not a Word document or could not be read.
export function legacyRefusalKey(refusal: DocxLegacyRefusal): DocxErrorKey {
	switch (refusal.reason) {
		case "legacyVersion":
			return "previewDocxLegacyFormat"
		case "encrypted":
		case "encryptedPackage":
			return "previewDocxUnsupportedEncryption"
		// The prompt answers a wrong password itself; reaching here, the file was not opened.
		case "wrongPassword":
			return "previewDocxNeedsPassword"
		case "notWordBinary":
		case "badSignature":
			return "previewDocxNotDocument"
		case "corrupt":
		case "tooLarge":
			return "previewDocxLoadFailed"
	}
}

// What the Word 97–2003 badge lists, by what the conversion could not carry over as it was (plural keys, given
// their count).
export type NotConvertedKey =
	| "previewDocxLegacyShapes"
	| "previewDocxLegacyGeometry"
	| "previewDocxLegacyWordArt"
	| "previewDocxLegacyObjects"
	| "previewDocxLegacyPictures"
	| "previewDocxLegacyArtBorders"
	| "previewDocxLegacyCharacters"
	| "previewDocxLegacyDamaged"
	| "previewDocxLegacyPassword"
	| "previewDocxLegacyMacros"
	| "previewDocxLegacyAutoText"

export function notConvertedKey(kind: DocNotConvertedKind): NotConvertedKey {
	switch (kind) {
		case "shape":
			return "previewDocxLegacyShapes"
		case "customGeometry":
			return "previewDocxLegacyGeometry"
		case "wordArt":
			return "previewDocxLegacyWordArt"
		case "embeddedObject":
			return "previewDocxLegacyObjects"
		case "picture":
			return "previewDocxLegacyPictures"
		case "artBorder":
			return "previewDocxLegacyArtBorders"
		case "specialCharacter":
			return "previewDocxLegacyCharacters"
		case "damagedContent":
			return "previewDocxLegacyDamaged"
		case "passwordProtection":
			return "previewDocxLegacyPassword"
		case "macros":
			return "previewDocxLegacyMacros"
		case "autoText":
			return "previewDocxLegacyAutoText"
	}
}

// A converted Word 97–2003 document, held in the docx worker while its preview shows it, released a turn after the
// preview let go of it (so a remount in the same turn, React's Strict Mode check, keeps it).
export interface DocxConversionKey {
	readonly document: DocxConvertedDocument
	hold: () => void
	drop: () => void
}

export function docxConversionKey(document: DocxConvertedDocument): DocxConversionKey {
	let timer: ReturnType<typeof setTimeout> | undefined

	return {
		document,
		hold: () => {
			clearTimeout(timer)
		},
		drop: () => {
			clearTimeout(timer)
			timer = setTimeout(() => {
				document.release()
			}, 0)
		}
	}
}

// An unlocked document, held where it was decrypted (the docx worker) while its preview shows it, and released
// once the preview let go of it (drop). The release waits a turn, so the viewer and editor close first and a
// remount in the same turn (React's Strict Mode check) keeps it.
export interface DocxSessionKey {
	readonly document: DocxUnlockedDocument
	hold: () => void
	drop: () => void
}

export function docxSessionKey(document: DocxUnlockedDocument): DocxSessionKey {
	let timer: ReturnType<typeof setTimeout> | undefined

	return {
		document,
		hold: () => {
			clearTimeout(timer)
		},
		drop: () => {
			clearTimeout(timer)
			timer = setTimeout(() => {
				document.release()
			}, 0)
		}
	}
}

// Why a document opens view-only: the file's own gate reasons (protection, signature, template, Strict
// markup, damage) and where the file was opened from.
export type DocxGateReason = DocxOpenInfo["gate"][number]
export type DocxContextReason = "publicLink" | "archive" | "linkedFile" | "trash" | "sharedIn" | "notInDrive"
// Opened for editing, then read-only: renamed to another format, or no longer savable (its directory went),
// or a text box that cannot be edited (its text flows on into another box, its copy for older readers does not
// match it, or the block holding it is locked).
export type DocxEditingReason = "renamed" | "notWritable" | "linkedTextbox" | "textboxFallback" | "lockedTextbox"
export type DocxViewOnlyReason = DocxGateReason | DocxContextReason | DocxEditingReason

export interface DocxOpenContext {
	// Opened from a public link (the anonymous surface).
	anon: boolean
	// An archive's entry, read from the archive rather than the drive.
	archive: boolean
	// Someone else's file reached through their link (a chat's link card): its listing variant says nothing.
	linked: boolean
	// The drive listing it was opened from; undefined outside the drive.
	variant: DriveVariant | undefined
}

export function docxContextReason(context: DocxOpenContext): DocxContextReason | null {
	if (context.anon) {
		return "publicLink"
	}

	if (context.archive) {
		return "archive"
	}

	if (context.linked) {
		return "linkedFile"
	}

	switch (context.variant) {
		case "trash":
			return "trash"
		case "sharedIn":
			return "sharedIn"
		case "recents":
		case "favorites":
		case "links":
		case "sharedOut":
			return "notInDrive"
		default:
			return null
	}
}

export function viewOnlyReasons(gate: readonly DocxGateReason[], context: DocxOpenContext): DocxViewOnlyReason[] {
	const where = docxContextReason(context)

	return where === null ? [...gate] : [where, ...gate]
}

export function viewOnlyReasonKey(reason: DocxViewOnlyReason): PreviewKey {
	switch (reason) {
		case "protected":
			return "previewDocxViewOnlyProtected"
		case "writeProtected":
			return "previewDocxViewOnlyWriteProtected"
		case "signed":
			return "previewDocxViewOnlySigned"
		case "strict":
			return "previewDocxViewOnlyStrict"
		case "malformed":
			return "previewDocxViewOnlyMalformed"
		case "publicLink":
			return "previewDocxViewOnlyPublicLink"
		case "archive":
			return "previewDocxViewOnlyArchive"
		case "linkedFile":
			return "previewDocxViewOnlyLinkedFile"
		case "trash":
			return "previewDocxViewOnlyTrash"
		case "sharedIn":
			return "previewDocxViewOnlySharedIn"
		case "notInDrive":
			return "previewDocxViewOnlyNotInDrive"
		case "renamed":
			return "previewDocxViewOnlyRenamed"
		case "notWritable":
			return "previewDocxViewOnlyNotWritable"
		case "linkedTextbox":
			return "previewDocxViewOnlyLinkedTextbox"
		case "textboxFallback":
			return "previewDocxViewOnlyTextboxFallback"
		case "lockedTextbox":
			return "previewDocxViewOnlyLockedTextbox"
	}
}

// WordprocessingML property elements (local names) a formatting change names, by the label Word's balloon
// gives them. Elements not listed (layout details such as kerning or rsids) are left out of the label.
const PROPERTY_KEYS: Readonly<Record<string, PreviewKey>> = {
	b: "previewDocxPropertyBold",
	bCs: "previewDocxPropertyBold",
	i: "previewDocxPropertyItalic",
	iCs: "previewDocxPropertyItalic",
	u: "previewDocxPropertyUnderline",
	strike: "previewDocxPropertyStrikethrough",
	dstrike: "previewDocxPropertyStrikethrough",
	rFonts: "previewDocxPropertyFont",
	sz: "previewDocxPropertyFontSize",
	szCs: "previewDocxPropertyFontSize",
	color: "previewDocxPropertyFontColor",
	highlight: "previewDocxPropertyHighlight",
	shd: "previewDocxPropertyShading",
	vertAlign: "previewDocxPropertyPosition",
	position: "previewDocxPropertyPosition",
	caps: "previewDocxPropertyCaps",
	smallCaps: "previewDocxPropertyCaps",
	rStyle: "previewDocxPropertyStyle",
	pStyle: "previewDocxPropertyStyle",
	jc: "previewDocxPropertyAlignment",
	ind: "previewDocxPropertyIndent",
	spacing: "previewDocxPropertySpacing",
	numPr: "previewDocxPropertyNumbering",
	tabs: "previewDocxPropertyTabs",
	pBdr: "previewDocxPropertyBorders",
	bdr: "previewDocxPropertyBorders",
	keepNext: "previewDocxPropertyPagination",
	keepLines: "previewDocxPropertyPagination",
	pageBreakBefore: "previewDocxPropertyPagination",
	widowControl: "previewDocxPropertyPagination"
}

// The labels of a formatting change's properties, each once, in the order the change names them.
export function formattingKeys(target: DocxRevisionTarget, properties: readonly string[]): PreviewKey[] {
	if (target === "table") {
		return ["previewDocxPropertyTable"]
	}

	const keys: PreviewKey[] = []

	for (const property of properties) {
		const key = PROPERTY_KEYS[property]

		if (key !== undefined && !keys.includes(key)) {
			keys.push(key)
		}
	}

	return keys
}

// Balloons need this much width beside the page (screen px); a narrower viewer shows markers instead.
export const BALLOON_COLUMN_WIDTH = 280
export const BALLOONS_MIN_VIEWPORT = 720

export function balloonsFit(viewportWidth: number): boolean {
	return viewportWidth >= BALLOONS_MIN_VIEWPORT
}

// Whether a markup mode puts anything in the margin: comments, or (all markup) formatting changes.
export function hasBalloons(annotations: DocxAnnotations, markup: DocxMarkupInfo): boolean {
	return (
		(markup.comments && annotations.comments.length > 0) ||
		(markup.formatting && annotations.revisions.some(revision => revision.kind === "formatting" && revision.target !== "section"))
	)
}

// The markup menu's label of each mode.
export const MARKUP_LABELS: Readonly<Record<DocxMarkupMode, PreviewKey>> = {
	all: "previewDocxMarkupAll",
	simple: "previewDocxMarkupSimple",
	none: "previewDocxMarkupNone",
	original: "previewDocxMarkupOriginal"
}

// What the find field drives: the viewer's find over laid-out pages, or the editor's over the document it
// edits (which can also replace).
export interface DocxFindControls {
	// The query last searched, and how.
	query: string
	caseSensitive: boolean
	// Word's "Find whole words only"; absent where the find has no such option (its toggle is not shown).
	wholeWord?: boolean
	count: number
	// There are more matches than `count` (a find shows so many at most).
	capped: boolean
	// The current match (0-based), -1 for none.
	active: number
	// `wholeWord` is passed back as `wholeWord` holds it (undefined where the find has no such option).
	search: (query: string, caseSensitive: boolean, wholeWord?: boolean) => void
	step: (direction: 1 | -1) => void
	close: () => void
	// Editing: replace the current match or every match; absent while viewing.
	replace?: {
		disabled: boolean
		one: (replacement: string) => void
		all: (replacement: string) => void
	}
}

export function viewerFindControls(state: DocxViewerState, dispatch: (command: DocxViewerCommand) => void): DocxFindControls {
	return {
		query: state.find.query,
		caseSensitive: state.find.caseSensitive,
		wholeWord: state.find.wholeWord,
		count: state.find.count,
		capped: state.find.capped,
		active: state.find.active,
		search: (query, caseSensitive, wholeWord) => {
			dispatch({ type: "find.query", query, caseSensitive, ...(wholeWord === undefined ? {} : { wholeWord }) })
		},
		step: direction => {
			dispatch({ type: direction > 0 ? "find.next" : "find.previous" })
		},
		close: () => {
			dispatch({ type: "find.close" })
		}
	}
}

// The format the docx viewer opens a file as, by its name: OpenDocument text is translated in the docx worker and
// shown view-only (no editor, no docx-preview fallback); RTF is read in the docx worker and edited and saved as RTF.
export function docxFormatOf(name: string): "docx" | "odt" | "rtf" {
	const extension = extensionOf(name)

	if (extension === "rtf") {
		return "rtf"
	}

	return extension === "odt" || extension === "ott" ? "odt" : "docx"
}
