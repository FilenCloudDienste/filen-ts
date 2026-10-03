import type { ArchiveFormat } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { ENTRY_FLAG, ENTRY_KIND, type SkipReason } from "@/lib/sdk/archiveListing"
import type { PreviewKey } from "@/lib/i18n"
import { listboxKeyTarget } from "@/features/drive/lib/listbox"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingPhase, ListingSnapshot, ListSummary } from "@/features/archive/lib/listingSession"
import {
	isSelectable,
	rowCheck,
	selectionTotals,
	type RowCheck,
	type Selection,
	type SelectionTotals
} from "@/features/archive/lib/selection"
import { childRows, dirOfRef, dirRef, isDirRef, type ChildSort, type RowRef, type RowView } from "@/features/archive/lib/sortedChildren"

// The archive browser's pure parts: its key table, the rows it shows and the labels it picks. Helpers
// taking a ListingSnapshot read its store through it on purpose: the store is mutated in place, so the
// snapshot (a new object per notification) is what tells the React Compiler their answer changed.

export const ARCHIVE_ROW_HEIGHT = 36
export const ARCHIVE_LIST_OVERSCAN = 10
// A quick name lookup or zip index read shows no spinner at all.
export const ARCHIVE_SPINNER_DELAY_MS = 300
export const ARCHIVE_PROGRESS_DELAY_MS = 400
export const ARCHIVE_SEARCH_DEBOUNCE_MS = 150
// Breadcrumb levels shown below the root; any above them fold into "…".
export const ARCHIVE_VISIBLE_CRUMBS = 3

export type CursorMove = "up" | "down" | "home" | "end" | "pageUp" | "pageDown"

export type BrowserKeyAction =
	| { type: "move"; move: CursorMove; extend: boolean }
	// A directory opens, a file toggles.
	| { type: "open" }
	| { type: "parent" }
	| { type: "toggle" }
	| { type: "selectAll" }
	| { type: "clear" }
	| { type: "focusSearch" }

export interface KeyInput {
	key: string
	shiftKey: boolean
	altKey: boolean
	metaKey: boolean
	ctrlKey: boolean
}

const MOVES: Readonly<Record<string, CursorMove>> = {
	ArrowUp: "up",
	ArrowDown: "down",
	Home: "home",
	End: "end",
	PageUp: "pageUp",
	PageDown: "pageDown"
}

// What a key pressed on the list does; null leaves it to the overlay. ArrowLeft/ArrowRight are never
// taken (they page the overlay), nor is Escape without a selection (it closes the overlay).
export function browserKeyAction(event: KeyInput, hasSelection: boolean): BrowserKeyAction | null {
	const mod = event.metaKey || event.ctrlKey

	if (event.key === "ArrowUp" && event.altKey) {
		return { type: "parent" }
	}

	const move = MOVES[event.key]

	if (move !== undefined) {
		return mod || event.altKey ? null : { type: "move", move, extend: event.shiftKey }
	}

	switch (event.key) {
		case "Enter":
			return mod ? null : { type: "open" }
		case "Backspace":
			return mod ? null : { type: "parent" }
		case " ":
			return mod ? null : { type: "toggle" }
		case "Escape":
			return hasSelection ? { type: "clear" } : null
		case "/":
			return mod ? null : { type: "focusSearch" }
		case "a":
		case "A":
			return mod && !event.shiftKey && !event.altKey ? { type: "selectAll" } : null
		case "f":
		case "F":
			return mod && !event.shiftKey && !event.altKey ? { type: "focusSearch" } : null
		default:
			return null
	}
}

const LIST_KEYS = { up: "ArrowUp", down: "ArrowDown", home: "Home", end: "End" } as const satisfies Record<
	Exclude<CursorMove, "pageUp" | "pageDown">,
	string
>

// Where a move puts the cursor, clamped; null for an empty list.
export function cursorTarget(move: CursorMove, cursor: number, count: number, pageSize: number): number | null {
	if (count === 0) {
		return null
	}

	const page = Math.max(pageSize, 1)
	const target =
		move === "pageUp"
			? cursor - page
			: move === "pageDown"
				? cursor + page
				: (listboxKeyTarget(LIST_KEYS[move], cursor, count, 1, false) ?? cursor)

	return Math.min(Math.max(target, 0), count - 1)
}

// The rows of a directory, its directories first.
export function directoryRows(snapshot: ListingSnapshot, dir: number, sort: ChildSort): RowView {
	return childRows(snapshot.store, dir, sort)
}

// The directory at `path`, the root while it hasn't arrived (or a new listing lacks it).
export function dirOfPath(snapshot: ListingSnapshot, path: string): number {
	return Math.max(snapshot.store.findDir(path), 0)
}

// Whether the directory holds anything an extract would create.
export function dirSelectable(snapshot: ListingSnapshot, dir: number): boolean {
	return snapshot.store.aggEntries(dir) > 0
}

export function refsView(refs: Int32Array): RowView {
	return { count: refs.length, at: i => refs[i] ?? 0 }
}

// Where `ref` sits now: at `hint` while nothing moved it, else found again (a listing merged rows in
// above it); null once it is gone.
export function findRow(rows: RowView, ref: RowRef, hint: number): number | null {
	if (hint >= 0 && hint < rows.count && rows.at(hint) === ref) {
		return hint
	}

	for (let i = 0; i < rows.count; i++) {
		if (rows.at(i) === ref) {
			return i
		}
	}

	return null
}

// A row the cursor (or a range's anchor) sits on, by identity: a listing still streaming merges rows in
// above it. `index` is where it was last seen.
export interface RowPosition {
	ref: RowRef
	index: number
}

// The cursor's index now: the first row before any move, -1 in an empty list.
export function positionIndex(rows: RowView, position: RowPosition | null): number {
	if (rows.count === 0) {
		return -1
	}

	if (position === null) {
		return 0
	}

	return findRow(rows, position.ref, position.index) ?? Math.min(Math.max(position.index, 0), rows.count - 1)
}

// Rows `from` to `to` inclusive, either way round.
export function rowRange(rows: RowView, from: number, to: number): RowRef[] {
	const start = Math.max(Math.min(from, to), 0)
	const end = Math.min(Math.max(from, to), rows.count - 1)
	const refs: RowRef[] = []

	for (let i = start; i <= end; i++) {
		refs.push(rows.at(i))
	}

	return refs
}

export function selectionTotalsOf(snapshot: ListingSnapshot, selection: Selection): SelectionTotals {
	return selectionTotals(snapshot.store, selection)
}

// The header checkbox: on when the directory shown (or every selectable search match) is in, mixed when
// some are. A match is in by its own rule or one above it.
export function headerCheck(snapshot: ListingSnapshot, selection: Selection, dir: number, searchRefs: Int32Array | null): RowCheck {
	if (selection.rules.size === 0) {
		return "off"
	}

	if (searchRefs === null) {
		return selection.rules.get(dirRef(dir)) === true && !selection.inner.has(dir) ? "on" : "mixed"
	}

	let on = 0
	let selectable = 0

	for (const ref of searchRefs) {
		const check = rowCheck(snapshot.store, selection, ref)

		if (check === "mixed") {
			return "mixed"
		}

		if (isSelectable(snapshot.store, ref)) {
			selectable++

			if (check === "on") {
				on++
			}
		}
	}

	return on === 0 ? "off" : on === selectable ? "on" : "mixed"
}

// The directory chain from the root's first child down to `dir`.
export function crumbTrail(store: EntryStore, dir: number): number[] {
	const trail: number[] = []

	for (let node = dir; node > 0; node = store.dirParent(node)) {
		trail.push(node)
	}

	return trail.reverse()
}

// The levels a breadcrumb bar shows after the root, and those folded into its "…" menu.
export function splitCrumbs(trail: readonly number[], visible: number): { hidden: number[]; shown: number[] } {
	const cut = Math.max(trail.length - visible, 0)

	return { hidden: trail.slice(0, cut), shown: trail.slice(cut) }
}

export type EntryRowKind = "dir" | "file" | "link" | "other"

export function entryRowKind(store: EntryStore, ref: RowRef): EntryRowKind {
	if (isDirRef(ref)) {
		return "dir"
	}

	switch (store.kind(ref)) {
		case ENTRY_KIND.file:
		case ENTRY_KIND.hardlink:
			return "file"
		case ENTRY_KIND.symlink:
			return "link"
		case ENTRY_KIND.dir:
			// A pathless directory entry has no node of its own.
			return "dir"
		default:
			return "other"
	}
}

export function rowName(store: EntryStore, ref: RowRef): string {
	return isDirRef(ref) ? store.dirName(dirOfRef(ref)) : store.name(ref)
}

export function rowSkip(store: EntryStore, ref: RowRef): number {
	return isDirRef(ref) ? store.dirSkip(dirOfRef(ref)) : store.skip(ref)
}

export function rowFlags(store: EntryStore, ref: RowRef): number {
	if (!isDirRef(ref)) {
		return store.flags(ref)
	}

	const slot = store.dirEntrySlot(dirOfRef(ref))

	return slot < 0 ? 0 : store.flags(slot)
}

export function hasFlag(flags: number, flag: (typeof ENTRY_FLAG)[keyof typeof ENTRY_FLAG]): boolean {
	return (flags & flag) !== 0
}

export const SKIP_LABEL_KEYS = {
	symlink: "previewArchiveSkip_symlink",
	hardlink: "previewArchiveSkip_hardlink",
	device: "previewArchiveSkip_device",
	sparse: "previewArchiveSkip_sparse",
	unsupportedType: "previewArchiveSkip_unsupportedType",
	pathTooLong: "previewArchiveSkip_pathTooLong",
	pathTooDeep: "previewArchiveSkip_pathTooDeep",
	unsafePath: "previewArchiveSkip_unsafePath",
	overlappingData: "previewArchiveSkip_overlappingData",
	unsupportedMethod: "previewArchiveSkip_unsupportedMethod",
	antiItem: "previewArchiveSkip_antiItem",
	macMetadata: "previewArchiveSkip_macMetadata"
} as const satisfies Record<SkipReason, PreviewKey>

// The heading for a failed listing; null where the error's own label says it best (a dropped
// connection, a worker that died).
export function failureLabelKey(error: ErrorDTO): PreviewKey | null {
	switch (error.kind) {
		case "ArchiveUnsupported":
			return "previewArchiveFailedUnsupported"
		case "ArchiveCorrupt":
			return "previewArchiveFailedCorrupt"
		case "ArchiveTooLarge":
			return "previewArchiveFailedTooLarge"
		default:
			return null
	}
}

export function summaryOf(phase: ListingPhase): ListSummary | null {
	switch (phase.type) {
		case "done":
		case "stopped":
		case "failed":
			return phase.summary
		default:
			return null
	}
}

// A listing still holding the page's archive slot (or about to), which "Extract all" stops first.
export function holdsSlot(phase: ListingPhase): boolean {
	return phase.type === "starting" || phase.type === "waiting" || phase.type === "reading"
}

// Rows there are to pick from: a finished listing, or the entries a stopped or failed one left.
export function canExtractSelection(phase: ListingPhase, entryCount: number): boolean {
	switch (phase.type) {
		case "done":
			return true
		case "stopped":
		case "failed":
			return entryCount > 0
		default:
			return false
	}
}

// A zip's or 7z's listing reads only its index, so its progress says nothing worth a bar.
export function readsWholeArchive(format: ArchiveFormat | null): boolean {
	return format?.type !== "zip" && format?.type !== "sevenZ"
}

// The listbox's per-row element id, for aria-activedescendant.
export function rowElementId(listId: string, ref: RowRef): string {
	return isDirRef(ref) ? `${listId}-d${String(dirOfRef(ref))}` : `${listId}-e${String(ref)}`
}
