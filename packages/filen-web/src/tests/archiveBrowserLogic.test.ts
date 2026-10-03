import { describe, expect, it } from "vitest"
import { preview } from "@/locales/en/preview"
import { ENTRY_FLAG, SKIP_REASONS } from "@/lib/sdk/archiveListing"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { ListingPhase, ListingSnapshot, ListSummary } from "@/features/archive/lib/listingSession"
import { EMPTY_SELECTION, selectAll, setMany } from "@/features/archive/lib/selection"
import { childRows, dirRef } from "@/features/archive/lib/sortedChildren"
import {
	browserKeyAction,
	canExtractSelection,
	crumbTrail,
	cursorTarget,
	entryRowKind,
	failureLabelKey,
	findRow,
	hasFlag,
	headerCheck,
	holdsSlot,
	positionIndex,
	readsWholeArchive,
	refsView,
	rowElementId,
	rowFlags,
	rowRange,
	SKIP_LABEL_KEYS,
	splitCrumbs,
	summaryOf,
	type KeyInput
} from "@/features/archive/lib/archiveBrowser.logic"
import { storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

function key(name: string, mods: Partial<Omit<KeyInput, "key">> = {}): KeyInput {
	return { key: name, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods }
}

function error(kind: string): ErrorDTO {
	return { species: "sdk", kind, label: kind, message: kind }
}

const SUMMARY: ListSummary = {
	format: { type: "zip" },
	password: "notNeeded",
	totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
	undelivered: 0,
	duplicates: null,
	unaccountedBytes: 0,
	verifying: false,
	verifyWaiting: false,
	verifyError: null
}

describe("browserKeyAction", () => {
	it("moves the cursor on the vertical keys, extending with shift", () => {
		expect(browserKeyAction(key("ArrowDown"), false)).toEqual({ type: "move", move: "down", extend: false })
		expect(browserKeyAction(key("ArrowUp", { shiftKey: true }), false)).toEqual({ type: "move", move: "up", extend: true })
		expect(browserKeyAction(key("Home"), false)).toEqual({ type: "move", move: "home", extend: false })
		expect(browserKeyAction(key("End", { shiftKey: true }), false)).toEqual({ type: "move", move: "end", extend: true })
		expect(browserKeyAction(key("PageDown"), false)).toEqual({ type: "move", move: "pageDown", extend: false })
		expect(browserKeyAction(key("PageUp"), false)).toEqual({ type: "move", move: "pageUp", extend: false })
		expect(browserKeyAction(key("ArrowDown", { ctrlKey: true }), false)).toBeNull()
	})

	it("never takes Left/Right, which page the overlay", () => {
		for (const name of ["ArrowLeft", "ArrowRight"]) {
			expect(browserKeyAction(key(name), true)).toBeNull()
			expect(browserKeyAction(key(name, { shiftKey: true }), true)).toBeNull()
			expect(browserKeyAction(key(name, { altKey: true }), true)).toBeNull()
		}
	})

	it("takes Escape only while something is selected", () => {
		expect(browserKeyAction(key("Escape"), true)).toEqual({ type: "clear" })
		expect(browserKeyAction(key("Escape"), false)).toBeNull()
	})

	it("opens, toggles, goes up, selects all and focuses the search", () => {
		expect(browserKeyAction(key("Enter"), false)).toEqual({ type: "open" })
		expect(browserKeyAction(key(" "), false)).toEqual({ type: "toggle" })
		expect(browserKeyAction(key("Backspace"), false)).toEqual({ type: "parent" })
		expect(browserKeyAction(key("ArrowUp", { altKey: true }), false)).toEqual({ type: "parent" })
		expect(browserKeyAction(key("a", { metaKey: true }), false)).toEqual({ type: "selectAll" })
		expect(browserKeyAction(key("a", { ctrlKey: true }), false)).toEqual({ type: "selectAll" })
		expect(browserKeyAction(key("a"), false)).toBeNull()
		expect(browserKeyAction(key("f", { ctrlKey: true }), false)).toEqual({ type: "focusSearch" })
		expect(browserKeyAction(key("/"), false)).toEqual({ type: "focusSearch" })
		expect(browserKeyAction(key("Tab"), false)).toBeNull()
	})
})

describe("cursorTarget", () => {
	it("steps, jumps and pages within the list", () => {
		expect(cursorTarget("down", 0, 5, 3)).toBe(1)
		expect(cursorTarget("up", 0, 5, 3)).toBe(0)
		expect(cursorTarget("down", 4, 5, 3)).toBe(4)
		expect(cursorTarget("end", 1, 5, 3)).toBe(4)
		expect(cursorTarget("home", 3, 5, 3)).toBe(0)
		expect(cursorTarget("pageDown", 1, 5, 3)).toBe(4)
		expect(cursorTarget("pageUp", 4, 5, 3)).toBe(1)
		expect(cursorTarget("pageDown", 0, 5, 0)).toBe(1)
	})

	it("has nowhere to go in an empty list", () => {
		expect(cursorTarget("down", 0, 0, 3)).toBeNull()
	})
})

describe("rows and positions", () => {
	const store = storeOf(["b.txt", "a/x.txt", "c.txt"])
	const rows = childRows(store, 0, { key: "name", descending: false })
	const a = store.findDir("a")

	it("finds a row where it was, or again after a merge moved it", () => {
		expect(rows.count).toBe(3)
		expect(rows.at(0)).toBe(dirRef(a))
		expect(findRow(rows, 0, 1)).toBe(1)
		expect(findRow(rows, 0, 2)).toBe(1)
		expect(findRow(rows, 99, 0)).toBeNull()
	})

	it("resolves a position: the first row at first, the nearest once its row is gone", () => {
		expect(positionIndex(rows, null)).toBe(0)
		expect(positionIndex(rows, { ref: 2, index: 0 })).toBe(2)
		expect(positionIndex(rows, { ref: 99, index: 7 })).toBe(2)
		expect(positionIndex(refsView(new Int32Array(0)), null)).toBe(-1)
	})

	it("takes a range either way round", () => {
		expect(rowRange(rows, 2, 1)).toEqual([0, 2])
		expect(rowRange(rows, 0, 9)).toEqual([dirRef(a), 0, 2])
	})

	it("names each row's element after its ref", () => {
		expect(rowElementId("l", dirRef(a))).toBe(`l-d${String(a)}`)
		expect(rowElementId("l", 2)).toBe("l-e2")
	})

	it("tells the row kinds apart", () => {
		const links = storeOf([
			"f",
			{ path: "l", kind: { type: "symlink", target: "f" }, skip: "symlink" },
			{ path: "h", kind: { type: "hardlink", target: "f", targetId: { archive: TEST_ARCHIVE, index: 0 } } },
			{ path: "dev", kind: { type: "device" }, skip: "device" },
			"d/"
		])

		expect(entryRowKind(links, 0)).toBe("file")
		expect(entryRowKind(links, 1)).toBe("link")
		expect(entryRowKind(links, 2)).toBe("file")
		expect(entryRowKind(links, 3)).toBe("other")
		expect(entryRowKind(links, dirRef(links.findDir("d")))).toBe("dir")
	})
})

describe("rowFlags", () => {
	it("flags a directory only implied by its paths when its own name has a character the SDK flags", () => {
		const store = storeOf(["Invoice\u202Efdp.exe/readme.txt", "plain/a.txt", "zero\u200Bwidth/", "zero\u200Bwidth/b.txt"])
		const flagged = (path: string): boolean => hasFlag(rowFlags(store, dirRef(store.findDir(path))), ENTRY_FLAG.misleading)

		expect(store.dirEntrySlot(store.findDir("Invoice\u202Efdp.exe"))).toBe(-1)
		expect(flagged("Invoice\u202Efdp.exe")).toBe(true)
		expect(flagged("plain")).toBe(false)
		// A directory with its own entry has the entry's flags, as the SDK set them.
		expect(flagged("zero\u200Bwidth")).toBe(false)
	})
})

describe("headerCheck", () => {
	const store = storeOf(["a/x.txt", "a/y.txt", "b.txt", { path: "c.lnk", skip: "symlink" }])
	const snapshot: ListingSnapshot = { phase: { type: "done", summary: SUMMARY }, store, version: 0, info: null }
	const a = store.findDir("a")

	it("is on for the whole directory, mixed for part of it", () => {
		expect(headerCheck(snapshot, EMPTY_SELECTION, 0, null)).toBe("off")
		expect(headerCheck(snapshot, selectAll(store, 0), 0, null)).toBe("on")
		expect(headerCheck(snapshot, setMany(store, selectAll(store, 0), [2], false), 0, null)).toBe("mixed")
		expect(headerCheck(snapshot, setMany(store, EMPTY_SELECTION, [dirRef(a)], true), 0, null)).toBe("mixed")
	})

	it("is on in search mode once every match is", () => {
		const refs = new Int32Array([0, 1])

		expect(headerCheck(snapshot, setMany(store, EMPTY_SELECTION, [0, 1], true), 0, refs)).toBe("on")
		expect(headerCheck(snapshot, setMany(store, EMPTY_SELECTION, [0], true), 0, refs)).toBe("mixed")
	})

	it("counts a match its directory's rule takes in, and skips one that can't be selected", () => {
		const refs = new Int32Array([0, 1, 3])
		const viaDir = setMany(store, EMPTY_SELECTION, [dirRef(a)], true)

		expect(headerCheck(snapshot, viaDir, 0, refs)).toBe("on")
		expect(headerCheck(snapshot, setMany(store, viaDir, [1], false), 0, refs)).toBe("mixed")
	})

	it("is off in search mode when no match is in, whatever else is", () => {
		expect(headerCheck(snapshot, setMany(store, EMPTY_SELECTION, [2], true), 0, new Int32Array([0, 1]))).toBe("off")
	})

	it("is mixed for a matched directory partly in", () => {
		const partly = setMany(store, EMPTY_SELECTION, [0], true)

		expect(headerCheck(snapshot, partly, 0, new Int32Array([dirRef(a)]))).toBe("mixed")
	})
})

describe("breadcrumbs", () => {
	const store = storeOf(["a/b/c/d/e.txt"])
	const d = store.findDir("a/b/c/d")

	it("runs from the root's child down, the upper levels folded", () => {
		const trail = crumbTrail(store, d)

		expect(trail.map(id => store.dirName(id))).toEqual(["a", "b", "c", "d"])
		expect(crumbTrail(store, 0)).toEqual([])

		const { hidden, shown } = splitCrumbs(trail, 2)

		expect(hidden.map(id => store.dirName(id))).toEqual(["a", "b"])
		expect(shown.map(id => store.dirName(id))).toEqual(["c", "d"])
		expect(splitCrumbs([1], 2)).toEqual({ hidden: [], shown: [1] })
	})
})

describe("phases", () => {
	const done: ListingPhase = { type: "done", summary: SUMMARY }
	const reading: ListingPhase = { type: "reading", bytesRead: 1, archiveBytes: 2, entries: 3, bytesPerSecond: null, etaMs: null }

	it("lets a selection be extracted from what a finished, stopped or failed listing holds", () => {
		expect(canExtractSelection(done, 0)).toBe(true)
		expect(canExtractSelection({ type: "stopped", summary: SUMMARY }, 1)).toBe(true)
		expect(canExtractSelection({ type: "stopped", summary: SUMMARY }, 0)).toBe(false)
		expect(canExtractSelection({ type: "failed", error: error("ArchiveCorrupt"), summary: SUMMARY }, 4)).toBe(true)
		expect(canExtractSelection(reading, 4)).toBe(false)
		expect(canExtractSelection({ type: "gate", format: null }, 0)).toBe(false)
	})

	it("knows which phases hold the archive slot", () => {
		expect(holdsSlot(reading)).toBe(true)
		expect(holdsSlot({ type: "waiting" })).toBe(true)
		expect(holdsSlot({ type: "starting" })).toBe(true)
		expect(holdsSlot(done)).toBe(false)
		expect(holdsSlot({ type: "gate", format: null })).toBe(false)
	})

	it("reads a summary off the settled phases only", () => {
		expect(summaryOf(done)).toBe(SUMMARY)
		expect(summaryOf(reading)).toBeNull()
	})

	it("shows a byte bar only where the listing reads the whole archive", () => {
		expect(readsWholeArchive({ type: "zip" })).toBe(false)
		expect(readsWholeArchive({ type: "sevenZ" })).toBe(false)
		expect(readsWholeArchive({ type: "tar", codec: undefined })).toBe(true)
		expect(readsWholeArchive(null)).toBe(true)
	})
})

describe("labels", () => {
	it("labels every skip reason from the catalog", () => {
		for (const reason of SKIP_REASONS) {
			expect(preview[SKIP_LABEL_KEYS[reason]]).toBeTruthy()
		}
	})

	it("heads a failure by its kind, else leaves it to the error's own label", () => {
		expect(failureLabelKey(error("ArchiveCorrupt"))).toBe("previewArchiveFailedCorrupt")
		expect(failureLabelKey(error("ArchiveUnsupported"))).toBe("previewArchiveFailedUnsupported")
		expect(failureLabelKey(error("ArchiveTooLarge"))).toBe("previewArchiveFailedTooLarge")
		expect(failureLabelKey(error("ArchiveWorkerDied"))).toBeNull()
		expect(failureLabelKey(error("Network"))).toBeNull()
	})
})
