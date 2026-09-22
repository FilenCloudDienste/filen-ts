// Add `item` to `arr` if absent (by id), remove if present. Returns a new array — input is not
// mutated.
export function toggleInArray<T>(arr: T[], item: T, getId: (i: T) => string): T[] {
	const id = getId(item)
	const idx = arr.findIndex(i => getId(i) === id)

	if (idx >= 0) {
		return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
	}

	return [...arr, item]
}

// Drop every item whose id is in idsToRemove. Returns the SAME array reference when nothing was
// removed, so a caller can skip a store write (and the re-render it would trigger).
export function removeSelectedIds<T>(items: readonly T[], idsToRemove: Iterable<string>, getId: (item: T) => string): T[] {
	const toRemove = new Set(idsToRemove)
	const next = items.filter(item => !toRemove.has(getId(item)))

	return next.length === items.length ? (items as T[]) : next
}

// Drop selected items that fail `keep` (a live-membership check, or an arbitrary predicate) —
// the "purge selection ghosts" rule run after a refetch, a narrowing view, or a visibility change.
// Returns the SAME array reference when nothing changed, so a caller can skip a store write.
export function pruneSelection<T>(selected: T[], keep: (item: T) => boolean): T[] {
	const kept = selected.filter(keep)

	return kept.length === selected.length ? selected : kept
}

// Ids of selected items that fail `keep` — the dropped-side mirror of pruneSelection, for callers
// that purge by id through a separate removal call (e.g. a store's own removeFromSelection) instead
// of writing the kept array back directly.
export function droppedIds<T>(selected: readonly T[], keep: (item: T) => boolean, getId: (item: T) => string): string[] {
	return selected.filter(item => !keep(item)).map(getId)
}
