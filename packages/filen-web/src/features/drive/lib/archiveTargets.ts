import type { EntryNameErrorKindJS } from "@filen/sdk-rs"
import { driveItemName, extensionStart, type JobDestination, type SourceDisposalKind } from "@filen/shared"
import { i18n, type ArchiveKey } from "@/lib/i18n"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import type { ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import { formatChoice, isArchiveCandidateName, type FormatChoiceId } from "@/features/drive/lib/archiveFormats"

// What compress and extract may act on, where their output goes by default and what it is called:
// shared by the menus, the quick actions (archiveActions.ts) and the dialogs. No SDK calls.

export type NameOf = (uuid: string) => string | undefined

// The flat listings' parent markers name no directory.
const PARENT_MARKERS: ReadonlySet<string> = new Set(["trash", "recents", "favorites", "links"])

// The SDK removes only plain items of the user's own drive: never a shared arm, which is all Shared
// with me and Shared by me list (someone else's item, or a share's own view of the user's).
export function canDisposeSources(variant: DriveVariant, items: readonly DriveItem[]): boolean {
	return (
		!isReadOnlySharedVariant(variant) &&
		variant !== "sharedOut" &&
		variant !== "trash" &&
		items.every(item => item.type === "file" || item.type === "directory")
	)
}

// The parent every item shares as a listing keys it (null for My Drive's root); undefined when they
// differ or one has no real parent. A shared root item's parent is itself, so never shared.
function commonParent(items: readonly DriveItem[]): string | null | undefined {
	const first = items[0]

	if (first === undefined) {
		return undefined
	}

	const parent = first.data.parent

	if (PARENT_MARKERS.has(parent) || items.some(item => item.data.parent !== parent || item.data.uuid === parent)) {
		return undefined
	}

	return normalizeParentUuid(parent, currentRootUuid())
}

function destinationName(uuid: string, nameOf: NameOf): string {
	return nameOf(uuid) ?? i18n.t("drive:driveMoveDestinationFallback")
}

// Next to the items; My Drive's root in Shared with me (someone else's directory) or when they lie in
// different directories.
export function defaultJobDestination(
	items: readonly DriveItem[],
	variant: DriveVariant,
	rootName: string,
	nameOf: NameOf
): JobDestination {
	const parent = isReadOnlySharedVariant(variant) ? undefined : commonParent(items)

	if (parent === undefined || parent === null) {
		return { uuid: null, name: rootName }
	}

	return { uuid: parent, name: destinationName(parent, nameOf) }
}

// Whose names a common parent directory is read from (the cached drive listings by default), and what
// items in different directories are named after. Photos knows its directories itself and names a mix of
// them after itself.
export interface ParentNaming {
	nameOf?: NameOf | undefined
	mixedFallback?: string | undefined
}

// What an archive's default name is made from: each item's name and whether it is a directory. Items
// without a drive shape (a public link's) are named by their caller.
export interface NamingEntry {
	name: string
	directory: boolean
}

export function namingEntries(items: readonly DriveItem[]): NamingEntry[] {
	return items.map(item => ({ name: driveItemName(item), directory: isDirectoryItem(item) }))
}

// The common parent directory's name, which several items' archive is named after; null at My Drive's
// root or when the name is not known. Items in different directories take `mixedFallback` (Photos names
// them after itself), else null.
export function archiveParentName(items: readonly DriveItem[], nameOf: NameOf, mixedFallback?: string): string | null {
	const parent = commonParent(items)

	if (parent === undefined) {
		return mixedFallback ?? null
	}

	return parent === null ? null : (nameOf(parent) ?? null)
}

// Without the format's extension, which composeArchiveName adds.
export function defaultArchiveBaseName(
	entries: readonly NamingEntry[],
	choice: FormatChoiceId,
	parentName: string | null,
	fallback: string
): string {
	const only = entries.length === 1 ? entries[0] : undefined

	if (only === undefined) {
		return parentName ?? fallback
	}

	// A single compressed file keeps the whole name: photo.jpg.gz.
	if (only.directory || formatChoice(choice).family === "single") {
		return only.name
	}

	const dot = extensionStart(only.name)

	return dot === -1 ? only.name : only.name.slice(0, dot)
}

// A name the user typed with the extension already on it does not get it twice.
export function composeArchiveName(base: string, extension: string): string {
	const trimmed = base.trim()

	return trimmed.toLowerCase().endsWith(extension.toLowerCase()) ? trimmed : `${trimmed}${extension}`
}

// Why a name the SDK refuses (useItemNameError) can't be used.
export const ITEM_NAME_ERROR_KEYS: Record<EntryNameErrorKindJS, ArchiveKey> = {
	Empty: "archiveName_Empty",
	TooLong: "archiveName_TooLong",
	ForbiddenChar: "archiveName_ForbiddenChar",
	ReservedName: "archiveName_ReservedName",
	TrailingDotOrSpace: "archiveName_TrailingDotOrSpace",
	LeadingSpace: "archiveName_LeadingSpace",
	DotEntry: "archiveName_DotEntry"
}

export function canExtractItem(variant: DriveVariant, item: DriveItem): boolean {
	return variant !== "trash" && !isDirectoryItem(item) && !item.data.undecryptable && isArchiveCandidateName(driveItemName(item))
}

// The archive's own directory; null in Shared with me or when it has no real parent.
export function extractHereDestination(variant: DriveVariant, item: DriveItem, rootName: string, nameOf: NameOf): JobDestination | null {
	if (isReadOnlySharedVariant(variant)) {
		return null
	}

	const parent = commonParent([item])

	if (parent === undefined) {
		return null
	}

	return parent === null ? { uuid: null, name: rootName } : { uuid: parent, name: destinationName(parent, nameOf) }
}

// Only an own archive, and only once all of it is extracted.
export function canDisposeArchive(variant: DriveVariant, item: DriveItem, call: "all" | "entries"): boolean {
	return call === "all" && canDisposeSources(variant, [item])
}

export interface ExtractRequestOptions {
	root: "newFolder" | "destination"
	folderName?: string | undefined
	skipMacMetadata?: boolean | undefined
	dispose?: SourceDisposalKind | null | undefined
}

// Where an extract puts its output and how its row reads; a new directory without a name is named by
// the SDK after the archive. A single compressed file by its name still asks for the root chosen: the
// SDK reads the bytes, writes a real one straight into the destination whatever the root, and gives a
// tarball named like one (a .gz) the directory asked for. Its row reads as the file it should become.
export function extractRequestShape(
	info: ArchiveNameInfo,
	archiveName: string,
	root: ExtractRequestOptions["root"],
	folderName: string | undefined
): Pick<ExtractJobRequest, "root" | "rowName" | "glyph"> {
	const single = info.format?.type === "single"

	if (root === "destination") {
		return { root: { type: "destination" }, rowName: single ? info.defaultName : archiveName, glyph: single ? "file" : "items" }
	}

	return {
		root: folderName === undefined ? { type: "newFolder" } : { type: "newFolder", name: folderName },
		rowName: single ? info.defaultName : (folderName ?? info.defaultName),
		glyph: single ? "file" : "directory"
	}
}

// The whole archive.
export function extractRequest(
	item: DriveItem,
	info: ArchiveNameInfo,
	destination: JobDestination,
	options: ExtractRequestOptions
): Omit<ExtractJobRequest, "id"> {
	const archiveName = driveItemName(item)
	const folderName = options.folderName === undefined || options.folderName === "" ? undefined : options.folderName

	return {
		archive: { file: narrowToAnyFile(item), uuid: item.data.uuid, name: archiveName },
		destination,
		...extractRequestShape(info, archiveName, options.root, folderName),
		calls: [{ type: "all" }],
		skipMacMetadata: options.skipMacMetadata ?? true,
		dispose: options.dispose ?? null,
		basis: { type: "archiveRead" },
		formatHint: info.format?.type ?? null
	}
}
