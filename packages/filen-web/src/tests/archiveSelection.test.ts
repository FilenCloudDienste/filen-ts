import { describe, expect, it } from "vitest"
import {
	EMPTY_SELECTION,
	clearSelection,
	isSelectable,
	isSelected,
	rowCheck,
	selectAll,
	selectionTotals,
	setMany,
	toggle,
	type Selection
} from "@/features/archive/lib/selection"
import { dirRef } from "@/features/archive/lib/sortedChildren"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { packEntries, storeOf } from "@/tests/support/archiveEntries"

// docs/a.txt (10) · docs/b.txt (20) · docs/sub/c.txt (40) · top.txt (5) · skipped.lnk · empty/ (skipped children only)
function sample(): EntryStore {
	return storeOf([
		{ path: "docs/a.txt", size: 10 },
		{ path: "docs/b.txt", size: 20 },
		{ path: "docs/sub/c.txt", size: 40 },
		{ path: "top.txt", size: 5 },
		{ path: "skipped.lnk", kind: { type: "symlink", target: "x" }, skip: "symlink" },
		{ path: "hidden/._x", size: 3, skip: "macMetadata" }
	])
}

function dir(store: EntryStore, path: string): number {
	const id = store.findDir(path)

	if (id < 0) {
		throw new Error(`no directory ${path}`)
	}

	return dirRef(id)
}

function ruleCount(selection: Selection): number {
	return selection.rules.size
}

describe("archive selection", () => {
	it("toggles a single entry on and off, leaving no rule behind", () => {
		const store = sample()
		const on = toggle(store, EMPTY_SELECTION, 3)

		expect(isSelected(store, on, 3)).toBe(true)
		expect(rowCheck(store, on, 3)).toBe("on")
		expect(selectionTotals(store, on)).toEqual({ files: 1, bytes: 5, entries: 1 })

		const off = toggle(store, on, 3)

		expect(isSelected(store, off, 3)).toBe(false)
		expect(ruleCount(off)).toBe(0)
		expect(off.inner.size).toBe(0)
	})

	it("selects a directory as one rule that every row below inherits", () => {
		const store = sample()
		const docs = dir(store, "docs")
		const selection = toggle(store, EMPTY_SELECTION, docs)

		expect(ruleCount(selection)).toBe(1)
		expect(isSelected(store, selection, 0)).toBe(true)
		expect(isSelected(store, selection, 2)).toBe(true)
		expect(rowCheck(store, selection, dir(store, "docs/sub"))).toBe("on")
		expect(isSelected(store, selection, 3)).toBe(false)
		expect(selectionTotals(store, selection)).toEqual({ files: 3, bytes: 70, entries: 3 })
	})

	it("marks a directory with an exclusion inside as mixed, and keeps the totals exact", () => {
		const store = sample()
		const docs = dir(store, "docs")
		const selection = toggle(store, toggle(store, EMPTY_SELECTION, docs), 2)

		expect(selection.rules.get(docs)).toBe(true)
		expect(selection.rules.get(2)).toBe(false)
		expect(rowCheck(store, selection, docs)).toBe("mixed")
		expect(rowCheck(store, selection, dir(store, "docs/sub"))).toBe("mixed")
		expect(rowCheck(store, selection, 2)).toBe("off")
		expect(selectionTotals(store, selection)).toEqual({ files: 2, bytes: 30, entries: 2 })

		// Selecting it again drops the now-redundant rule.
		const again = toggle(store, selection, 2)

		expect(ruleCount(again)).toBe(1)
		// Only the root holds a rule now.
		expect([...again.inner]).toEqual([[0, 1]])
		expect(rowCheck(store, again, docs)).toBe("on")
	})

	it("turns a mixed directory fully on, dropping the rules inside it", () => {
		const store = sample()
		const docs = dir(store, "docs")
		const mixed = toggle(store, EMPTY_SELECTION, 0)

		expect(rowCheck(store, mixed, docs)).toBe("mixed")

		const on = toggle(store, mixed, docs)

		expect([...on.rules]).toEqual([[docs, true]])
		expect([...on.inner]).toEqual([[0, 1]])
		expect(selectionTotals(store, on)).toEqual({ files: 3, bytes: 70, entries: 3 })
	})

	it("keeps rules normalised through nested re-inclusions", () => {
		const store = sample()
		const docs = dir(store, "docs")
		const sub = dir(store, "docs/sub")
		let selection = toggle(store, EMPTY_SELECTION, docs)

		selection = toggle(store, selection, sub)
		selection = toggle(store, selection, 2)

		expect(selection.rules.get(sub)).toBe(false)
		expect(selection.rules.get(2)).toBe(true)
		expect(selectionTotals(store, selection)).toEqual({ files: 3, bytes: 70, entries: 3 })

		// Every rule differs from what its row would inherit.
		for (const [ref, value] of selection.rules) {
			const without = new Map(selection.rules)

			without.delete(ref)

			expect(isSelected(store, { rules: without, inner: selection.inner }, ref)).toBe(!value)
		}
	})

	it("selects everything in a directory with one rule", () => {
		const store = sample()
		const all = selectAll(store, 0)

		expect([...all.rules]).toEqual([[dirRef(0), true]])
		expect(selectionTotals(store, all)).toEqual({ files: 4, bytes: 75, entries: 4 })
		expect(isSelected(store, all, 3)).toBe(true)
		// A skipped row never shows as selected.
		expect(rowCheck(store, all, 4)).toBe("off")

		const docs = store.findDir("docs")
		const inDocs = selectAll(store, docs)

		expect(selectionTotals(store, inDocs).files).toBe(3)

		// Its rule can be taken away again without the counts going astray.
		const cleared = toggle(store, inDocs, dirRef(docs))

		expect(cleared.rules.size).toBe(0)
		expect(cleared.inner.size).toBe(0)
	})

	it("sets a range at once", () => {
		const store = sample()
		const docs = store.findDir("docs")
		const inDocs = selectAll(store, docs)
		const range = setMany(store, inDocs, [0, 1], false)

		expect(isSelected(store, range, 0)).toBe(false)
		expect(isSelected(store, range, 1)).toBe(false)
		expect(isSelected(store, range, 2)).toBe(true)
		expect(selectionTotals(store, range)).toEqual({ files: 1, bytes: 40, entries: 1 })

		const back = setMany(store, range, [0, 1], true)

		expect([...back.rules]).toEqual([[dirRef(docs), true]])
	})

	it("can't select skipped rows or directories holding nothing to extract", () => {
		const store = sample()
		const hidden = dir(store, "hidden")

		expect(isSelectable(store, 4)).toBe(false)
		expect(isSelectable(store, hidden)).toBe(false)
		expect(toggle(store, EMPTY_SELECTION, 4)).toBe(EMPTY_SELECTION)
		expect(toggle(store, EMPTY_SELECTION, hidden)).toBe(EMPTY_SELECTION)
		expect(setMany(store, EMPTY_SELECTION, [4, hidden, 3], true).rules.size).toBe(1)

		// A skipped row below a selected directory stays out of the totals.
		expect(selectionTotals(store, selectAll(store, 0)).entries).toBe(4)
	})

	it("lets entries listed later take their directory's rule", () => {
		const store = storeOf([{ path: "docs/a.txt", size: 10 }])
		const selection = toggle(store, EMPTY_SELECTION, dir(store, "docs"))

		for (const batch of packEntries([{ path: "docs/new.txt", size: 7, index: 1 }])) {
			store.append(batch)
		}

		expect(isSelected(store, selection, 1)).toBe(true)
		expect(selectionTotals(store, selection)).toEqual({ files: 2, bytes: 17, entries: 2 })
	})

	it("clears", () => {
		expect(clearSelection()).toBe(EMPTY_SELECTION)
	})
})
