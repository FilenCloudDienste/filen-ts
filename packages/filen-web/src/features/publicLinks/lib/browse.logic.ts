import type {
	AnyItemWithContext,
	AnyLinkedDir,
	DirPublicInfo,
	DirPublicLink,
	File as SdkFile,
	LinkedDir,
	LinkedDirsAndFiles,
	NonRootLinkedItem
} from "@filen/sdk-rs"
import { copyJobGlyph, driveItemName, nameSearchKey, type CopyJobGlyph } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { sortByDriveItem, type DriveSortBy } from "@/features/drive/lib/sort"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { OFFLINE_REASON_KEY, type ActionDescriptor } from "@/lib/actionDescriptor"
import { type DriveKey, type NamespaceKey } from "@/lib/i18n"

// Pure client-side model for browsing a linked directory. Navigation is a VIRTUAL stack (old-web
// parity): entering a subfolder pushes a crumb, breadcrumb clicks truncate it — the route's own uuid
// and URL fragment never change, so the decryption key and any verified password stay in memory for
// the whole session. Nothing here is async or React; the browse view drives every list/filter/sort
// decision through these transforms so they stay directly unit-testable.

// One navigable level. `dir` is the SDK handle the listing/size/zip calls want (a LinkedRootDir for the
// root crumb, a LinkedDir for every subfolder) — both are AnyLinkedDir. `name`/`uuid` are display only.
export interface BrowseCrumb {
	uuid: string
	name: string
	dir: AnyLinkedDir
}

// A listing row, pre-narrowed to a DriveItem so the SAME icon/name/size/date helpers the authed drive
// listing uses render it with no per-row branching. The raw SDK handle is kept alongside: `dir` for a
// deeper listing, `file` as the AnyFile a download/preview op wants. A search result also carries its `trail`: the
// directories from the one searched (not included) down to its own, empty for one of the searched directory itself.
export type BrowseEntry =
	| { kind: "dir"; item: DriveItem; dir: LinkedDir; trail?: readonly LinkedDir[] }
	| { kind: "file"; item: DriveItem; file: SdkFile; trail?: readonly LinkedDir[] }

// Name ascending, the drive's own default. Directories always precede files regardless (see sortEntries).
export const DEFAULT_PUBLIC_SORT: DriveSortBy = "nameAsc"

// Root crumb from the resolved link info: the linked root dir plus its decrypted name (uuid fallback
// for a still-encrypted meta, mirroring the resource resolver).
export function rootCrumb(info: DirPublicInfo): BrowseCrumb {
	const meta = info.root.inner.meta

	return {
		uuid: info.root.inner.uuid,
		name: meta.type === "decoded" ? meta.data.name : info.root.inner.uuid,
		dir: info.root
	}
}

// Push a subfolder crumb onto the stack (returns a new array — never mutates).
export function enterCrumb(stack: readonly BrowseCrumb[], entry: Extract<BrowseEntry, { kind: "dir" }>): BrowseCrumb[] {
	return [...stack, { uuid: entry.item.data.uuid, name: entryName(entry), dir: entry.dir }]
}

// Truncate the stack to a breadcrumb the user clicked (keeps indices 0..index). An out-of-range index
// leaves the stack unchanged rather than emptying it — a stale click never strands the view above root.
export function jumpToCrumb(stack: readonly BrowseCrumb[], index: number): BrowseCrumb[] {
	if (index < 0 || index >= stack.length) {
		return [...stack]
	}

	return stack.slice(0, index + 1)
}

// Narrow a raw listing into display entries. Every dir/file goes through the same narrowItem the owned
// drive listing uses, so icon/name/size/date read identically; the raw SDK handle rides alongside.
export function toBrowseEntries(listing: LinkedDirsAndFiles): BrowseEntry[] {
	const dirs: BrowseEntry[] = listing.dirs.map(dir => ({ kind: "dir", item: narrowItem(dir.inner), dir }))
	const files: BrowseEntry[] = listing.files.map(file => ({ kind: "file", item: narrowItem(file), file }))

	return [...dirs, ...files]
}

export function entryName(entry: BrowseEntry): string {
	return driveItemName(entry.item)
}

// A linked directory's or file's name as its narrowed item reads it (driveItemName), without narrowing it.
export function linkedItemName(item: LinkedDir | SdkFile): string {
	const { meta, uuid } = "inner" in item ? item.inner : item

	return meta.type === "decoded" ? meta.data.name : uuid
}

// A search result's directory path from the directory searched, "/"-joined; null for a listing's entry and for a result
// in the directory searched itself.
export function entryPath(entry: BrowseEntry): string | null {
	return entry.trail === undefined || entry.trail.length === 0 ? null : entry.trail.map(linkedItemName).join("/")
}

// Search results as display entries, narrowed as a listing's are.
export function toSearchEntries(hits: readonly { item: LinkedDir | SdkFile; trail: readonly LinkedDir[] }[]): BrowseEntry[] {
	return hits.map(({ item, trail }) =>
		"inner" in item
			? { kind: "dir", item: narrowItem(item.inner), dir: item, trail }
			: { kind: "file", item: narrowItem(item), file: item, trail }
	)
}

// A search result's directory opened: the crumbs down its trail onto it.
export function enterResultCrumbs(stack: readonly BrowseCrumb[], entry: Extract<BrowseEntry, { kind: "dir" }>): BrowseCrumb[] {
	const below = (entry.trail ?? []).map(dir => ({ uuid: dir.inner.uuid, name: linkedItemName(dir), dir }))

	return enterCrumb([...stack, ...below], entry)
}

// The drive listing's own order (@/features/drive/lib/sort): directories before files, the chosen field
// within each group, and the same deterministic tie order. A directory has no cheap size at this layer
// (getDirSize is a separate call), so a size sort orders directories by name alone.
export function sortEntries(entries: readonly BrowseEntry[], sort: DriveSortBy): BrowseEntry[] {
	return sortByDriveItem([...entries], entry => entry.item, sort)
}

// What a public directory's menus and selection bar offer, for one entry or a selection of them: Open (one entry), the
// download (a file, a directory's zip, or several as one zip) and Save to Cloud Drive (files and directories alike).
export type BrowseActionId = "open" | "download" | "saveToDrive"

export type BrowseLabelKey = DriveKey | `publicLinks:${NamespaceKey<"publicLinks">}`

export type BrowseActionDescriptor = ActionDescriptor<BrowseLabelKey, BrowseActionId, never>

export interface BrowseSelectionContext {
	// The link allows downloads; `saveable` (useLinkSaveable) the visitor may also copy it into their drive.
	downloadable: boolean
	saveable: boolean
	// Another download is running.
	busy: boolean
	isOnline: boolean
}

// The builder every surface reads: a row's right-click and ⋯ menu (over the selection when it is inside one) and the
// selection bar alike, each entry with the key that runs it on the selection.
export function browseSelectionActions(entries: readonly BrowseEntry[], context: BrowseSelectionContext): BrowseActionDescriptor[] {
	const [only] = entries

	if (only === undefined) {
		return []
	}

	const single = entries.length === 1 ? only : undefined
	const actions: BrowseActionDescriptor[] = []

	if (single !== undefined) {
		actions.push({
			id: "open",
			...(single.kind === "dir" ? ACTION_DEFS.openDirectory : ACTION_DEFS.openFile),
			run: "direct",
			kbdAction: "drive.open"
		})
	}

	if (context.downloadable) {
		// Several picks sharing a name would overwrite one another at the zip's top (a pick inside a picked directory goes
		// with it).
		const namesClash = single === undefined && picksShareName(withoutNestedPicks(entries))

		actions.push({
			id: "download",
			icon: ACTION_DEFS.download.icon,
			labelKey: single?.kind === "dir" ? "publicLinks:downloadAsZip" : ACTION_DEFS.download.labelKey,
			run: "direct",
			kbdAction: "links.download",
			pinned: true,
			...(namesClash
				? { enabled: false, disabledReasonKey: "publicLinks:selectionNamesClash" }
				: context.busy
					? { enabled: false }
					: {})
		})
	}

	if (context.saveable) {
		actions.push({
			id: "saveToDrive",
			icon: ACTION_DEFS.copy.icon,
			labelKey: "publicLinks:saveToDrive",
			run: "direct",
			kbdAction: "links.saveToDrive",
			pinned: true,
			...(context.isOnline ? {} : { enabled: false, disabledReasonKey: OFFLINE_REASON_KEY })
		})
	}

	return actions
}

// What a menu opened on `entry` acts on: the whole selection (`selected`, as listed) when the entry is part of a 2+ one,
// else the entry alone.
export function browseMenuEntries(
	entry: BrowseEntry,
	selected: readonly BrowseEntry[],
	selection: BrowseSelection
): readonly BrowseEntry[] {
	return selection.has(entryKey(entry)) && selection.size > 1 ? selected : [entry]
}

// The selection: uuids over the level on screen, the listing's own entries never copied.
export type BrowseSelection = ReadonlySet<string>

export const EMPTY_SELECTION: BrowseSelection = new Set()

export function entryKey(entry: BrowseEntry): string {
	return entry.item.data.uuid
}

// The selected entries in listing order.
export function selectedEntries(entries: readonly BrowseEntry[], selection: BrowseSelection): BrowseEntry[] {
	if (selection.size === 0) {
		return []
	}

	return entries.filter(entry => selection.has(entryKey(entry)))
}

export type SelectionCheck = "on" | "mixed" | "off"

// The column header's select-all box: on once every entry is selected.
export function selectionCheck(entries: readonly BrowseEntry[], selection: BrowseSelection): SelectionCheck {
	if (selection.size === 0 || entries.length === 0) {
		return "off"
	}

	return entries.every(entry => selection.has(entryKey(entry))) ? "on" : "mixed"
}

// The select-all box's click: everything, or nothing once everything is selected.
export function toggleAllSelection(entries: readonly BrowseEntry[], selection: BrowseSelection): BrowseSelection {
	return selectionCheck(entries, selection) === "on" ? EMPTY_SELECTION : new Set(entries.map(entryKey))
}

export function toggleSelection(selection: BrowseSelection, key: string): BrowseSelection {
	const next = new Set(selection)

	if (!next.delete(key)) {
		next.add(key)
	}

	return next
}

// Entries as the SDK copies them into the visitor's drive: a file as listed, a directory with the link.
export function browseSaveItems(entries: readonly BrowseEntry[], link: DirPublicLink): AnyItemWithContext[] {
	return entries.map(entry => (entry.kind === "file" ? entry.file : { dir: entry.dir, link }))
}

// The zip call takes the listed entries as they are; the selection's link travels beside them.
export function browseZipItems(entries: readonly BrowseEntry[]): NonRootLinkedItem[] {
	return entries.map(entry => (entry.kind === "file" ? entry.file : entry.dir))
}

export function browseSaveGlyph(entries: readonly BrowseEntry[]): CopyJobGlyph {
	return copyJobGlyph(entries.length, entries[0]?.kind === "dir")
}

// The picks a selection acts on: one inside a picked directory goes with that directory, so it is not taken twice (a
// search's results list a directory and what is below it side by side).
export function withoutNestedPicks(entries: readonly BrowseEntry[]): readonly BrowseEntry[] {
	const pickedDirs = new Set<string>()

	for (const entry of entries) {
		if (entry.kind === "dir") {
			pickedDirs.add(entryKey(entry))
		}
	}

	if (pickedDirs.size === 0) {
		return entries
	}

	return entries.filter(entry => entry.trail?.some(dir => pickedDirs.has(dir.inner.uuid)) !== true)
}

// Whether two picks share a name, compared as the search compares names (case and composition aside). A zip holds its
// picks at its top under their bare names, so such a selection would lose one of them on extraction. A level's own
// entries never do; a search's results from different directories can.
export function picksShareName(entries: readonly BrowseEntry[]): boolean {
	const names = new Set<string>()

	for (const entry of entries) {
		const key = nameSearchKey(entryName(entry))

		if (names.has(key)) {
			return true
		}

		names.add(key)
	}

	return false
}

// The selected files' bytes, or null when a directory is among them: its size is another request per directory.
export function selectionBytes(entries: readonly BrowseEntry[]): bigint | null {
	let total = 0n

	for (const entry of entries) {
		if (entry.kind === "dir") {
			return null
		}

		total += entry.file.size
	}

	return total
}
