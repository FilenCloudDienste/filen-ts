import { ENTRY_KIND } from "@/lib/sdk/archiveListing"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { dirOfRef, dirRef, isDirRef, type RowRef } from "@/features/archive/lib/sortedChildren"

// What the browser has selected, as rules rather than rows: a rule says a row and everything below it is
// in or out, and a row without one takes its nearest ancestor's. Selecting a directory is one rule
// however many entries it holds, entries a listing still streams in take their directory's rule, and
// the totals are a sum over the rules. Rules stay normalised: each says the opposite of what its row
// would take from above, so none is redundant and every directory holding one is mixed. Navigating
// clears the selection, so every rule sits in or below the viewed directory.
export interface Selection {
	rules: ReadonlyMap<RowRef, boolean>
	// The directories with a rule strictly inside them, by how many.
	inner: ReadonlyMap<number, number>
}

export type RowCheck = "on" | "off" | "mixed"

export interface SelectionTotals {
	// Unskipped files, hard links included, and their bytes as the archive states them.
	files: number
	bytes: number
	// Unskipped entries of any kind, directory entries included.
	entries: number
}

export const EMPTY_SELECTION: Selection = { rules: new Map(), inner: new Map() }

function parentDirOf(store: EntryStore, ref: RowRef): number {
	return isDirRef(ref) ? store.dirParent(dirOfRef(ref)) : store.parent(ref)
}

// A skipped row, and a directory holding nothing an extract would create, can't be selected.
export function isSelectable(store: EntryStore, ref: RowRef): boolean {
	if (isDirRef(ref)) {
		const dir = dirOfRef(ref)

		return store.dirSkip(dir) === 0 && store.aggEntries(dir) > 0
	}

	return store.skip(ref) === 0
}

// What a row takes from its ancestors' rules.
function inherited(store: EntryStore, rules: ReadonlyMap<RowRef, boolean>, ref: RowRef): boolean {
	for (let dir = parentDirOf(store, ref); dir >= 0; dir = store.dirParent(dir)) {
		const rule = rules.get(dirRef(dir))

		if (rule !== undefined) {
			return rule
		}
	}

	return false
}

export function isSelected(store: EntryStore, selection: Selection, ref: RowRef): boolean {
	return selection.rules.get(ref) ?? inherited(store, selection.rules, ref)
}

// A row that can't be selected shows as off whatever its directory's rule.
export function rowCheck(store: EntryStore, selection: Selection, ref: RowRef): RowCheck {
	if (!isSelectable(store, ref)) {
		return "off"
	}

	if (isDirRef(ref) && selection.inner.has(dirOfRef(ref))) {
		return "mixed"
	}

	return isSelected(store, selection, ref) ? "on" : "off"
}

function countInner(store: EntryStore, inner: Map<number, number>, ref: RowRef, delta: number): void {
	for (let dir = parentDirOf(store, ref); dir >= 0; dir = store.dirParent(dir)) {
		const count = (inner.get(dir) ?? 0) + delta

		if (count === 0) {
			inner.delete(dir)
		} else {
			inner.set(dir, count)
		}
	}
}

function isInside(store: EntryStore, ref: RowRef, dir: number): boolean {
	for (let node = parentDirOf(store, ref); node >= 0; node = store.dirParent(node)) {
		if (node === dir) {
			return true
		}
	}

	return false
}

// Applies one row's new state to working copies, keeping the rules normalised.
function setRule(store: EntryStore, rules: Map<RowRef, boolean>, inner: Map<number, number>, ref: RowRef, value: boolean): void {
	if (isDirRef(ref) && inner.has(dirOfRef(ref))) {
		const dir = dirOfRef(ref)

		// Deleting the entry being visited is safe for a Map's iterator.
		for (const inside of rules.keys()) {
			if (isInside(store, inside, dir)) {
				rules.delete(inside)
				countInner(store, inner, inside, -1)
			}
		}
	}

	const had = rules.has(ref)

	if (value === inherited(store, rules, ref)) {
		if (had) {
			rules.delete(ref)
			countInner(store, inner, ref, -1)
		}

		return
	}

	if (!had) {
		countInner(store, inner, ref, 1)
	}

	rules.set(ref, value)
}

function applyAll(store: EntryStore, selection: Selection, refs: Iterable<RowRef>, value: (ref: RowRef) => boolean): Selection {
	const rules = new Map(selection.rules)
	const inner = new Map(selection.inner)

	for (const ref of refs) {
		if (isSelectable(store, ref)) {
			setRule(store, rules, inner, ref, value(ref))
		}
	}

	return { rules, inner }
}

// A mixed directory turns fully on.
export function toggle(store: EntryStore, selection: Selection, ref: RowRef): Selection {
	if (!isSelectable(store, ref)) {
		return selection
	}

	const next = rowCheck(store, selection, ref) !== "on"

	return applyAll(store, selection, [ref], () => next)
}

// A shift-range, or every search result.
export function setMany(store: EntryStore, selection: Selection, refs: Iterable<RowRef>, value: boolean): Selection {
	return applyAll(store, selection, refs, () => value)
}

// Everything in the viewed directory, one rule whatever it holds.
export function selectAll(store: EntryStore, dir: number): Selection {
	if (store.aggEntries(dir) === 0) {
		return EMPTY_SELECTION
	}

	const rules = new Map<RowRef, boolean>()
	const inner = new Map<number, number>()

	setRule(store, rules, inner, dirRef(dir), true)

	return { rules, inner }
}

export function clearSelection(): Selection {
	return EMPTY_SELECTION
}

// Exact, as each rule adds or takes away its row's whole subtree and none repeats an ancestor's say.
export function selectionTotals(store: EntryStore, selection: Selection): SelectionTotals {
	let files = 0
	let bytes = 0
	let entries = 0

	for (const [ref, on] of selection.rules) {
		const sign = on ? 1 : -1

		if (isDirRef(ref)) {
			const dir = dirOfRef(ref)

			files += sign * store.aggFiles(dir)
			bytes += sign * store.aggBytes(dir)
			entries += sign * store.aggEntries(dir)

			continue
		}

		const kind = store.kind(ref)

		entries += sign

		if (kind === ENTRY_KIND.file || kind === ENTRY_KIND.hardlink) {
			files += sign
			bytes += sign * Math.max(store.size(ref), 0)
		}
	}

	return { files, bytes, entries }
}
