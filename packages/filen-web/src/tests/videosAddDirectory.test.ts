import { describe, expect, it } from "vitest"
import { activeLibraryRoots, emptyLibraryConfig, withLibraryRoot } from "@filen/shared/videos"
import { addRootEdit, stepAfterSize, stepAfterValidation } from "@/features/videos/lib/addDirectory.logic"
import { chooserPickHint, isHiddenChooserRow, isRootRow } from "@/lib/rootChooser.logic"
import { ROOT_ENTRIES_LARGE } from "@/features/videos/lib/library.logic"

const ROOTS = [
	{ uuid: "movies", name: "Movies" },
	{ uuid: "shows", name: "Shows" }
]

describe("chooser rows", () => {
	it("hides Filen's own directory at the drive root only, whatever its case", () => {
		expect(isHiddenChooserRow({ name: ".filen", atDriveRoot: true, systemName: ".filen" })).toBe(true)
		expect(isHiddenChooserRow({ name: ".Filen", atDriveRoot: true, systemName: ".filen" })).toBe(true)
		expect(isHiddenChooserRow({ name: ".filen", atDriveRoot: false, systemName: ".filen" })).toBe(false)
		expect(isHiddenChooserRow({ name: "Movies", atDriveRoot: true, systemName: ".filen" })).toBe(false)
	})

	it("marks a library directory", () => {
		expect(isRootRow("movies", ROOTS)).toBe(true)
		expect(isRootRow("media", ROOTS)).toBe(false)
	})
})

describe("chooserPickHint", () => {
	it("says the open directory already is one, or which one it sits inside", () => {
		expect(chooserPickHint({ pathStack: ["drive", "media"], roots: ROOTS })).toEqual({ kind: "none" })
		expect(chooserPickHint({ pathStack: ["drive", "media", "movies"], roots: ROOTS })).toEqual({ kind: "alreadyRoot" })
		expect(chooserPickHint({ pathStack: ["drive", "movies", "4k"], roots: ROOTS })).toEqual({ kind: "insideRoot", root: ROOTS[0] })
		expect(chooserPickHint({ pathStack: [], roots: ROOTS })).toEqual({ kind: "none" })
		// Any depth below a library directory, and the nearest one when they nest.
		expect(chooserPickHint({ pathStack: ["drive", "media", "movies", "4k", "hdr"], roots: ROOTS })).toEqual({
			kind: "insideRoot",
			root: ROOTS[0]
		})
		expect(chooserPickHint({ pathStack: ["drive", "movies", "x", "shows", "y"], roots: ROOTS })).toEqual({
			kind: "insideRoot",
			root: ROOTS[1]
		})
	})
})

describe("stepAfterValidation", () => {
	it("goes on to the size read for a clear pick", () => {
		expect(stepAfterValidation({ uuid: "media", validation: { ok: true }, replacing: [] })).toEqual({
			kind: "sizing",
			uuid: "media",
			replace: []
		})
	})

	it("offers to replace overlapping directories", () => {
		expect(
			stepAfterValidation({ uuid: "4k", validation: { ok: false, reason: "nested", replace: ["movies"] }, replacing: [] })
		).toEqual({
			kind: "replace",
			uuid: "4k",
			replace: ["movies"]
		})
	})

	it("still offers a directory inside a library directory as its replacement", () => {
		expect(
			stepAfterValidation({
				uuid: "4k",
				validation: { ok: false, reason: "nested", replace: ["movies"], within: ["movies"] },
				replacing: []
			})
		).toEqual({
			kind: "replace",
			uuid: "4k",
			replace: ["movies"]
		})
	})

	it("needs no confirmation for an overlap with the directory being swapped, and keeps it replaced", () => {
		expect(
			stepAfterValidation({ uuid: "4k", validation: { ok: false, reason: "nested", replace: ["movies"] }, replacing: ["movies"] })
		).toEqual({
			kind: "sizing",
			uuid: "4k",
			replace: ["movies"]
		})
		expect(stepAfterValidation({ uuid: "other", validation: { ok: true }, replacing: ["movies"] })).toEqual({
			kind: "sizing",
			uuid: "other",
			replace: ["movies"]
		})
	})

	it("asks before replacing more than the directory being swapped", () => {
		expect(
			stepAfterValidation({
				uuid: "media",
				validation: { ok: false, reason: "nested", replace: ["movies", "shows"] },
				replacing: ["movies"]
			})
		).toEqual({
			kind: "replace",
			uuid: "media",
			replace: ["movies", "shows"]
		})
	})

	it("blocks Filen's own directory, a library directory and one that is gone", () => {
		expect(stepAfterValidation({ uuid: "x", validation: { ok: false, reason: "systemDirectory" }, replacing: [] })).toEqual({
			kind: "blocked",
			reason: "systemDirectory"
		})
		expect(stepAfterValidation({ uuid: "movies", validation: { ok: false, reason: "alreadyRoot" }, replacing: [] })).toEqual({
			kind: "blocked",
			reason: "alreadyRoot"
		})
		expect(stepAfterValidation({ uuid: "x", validation: { ok: false, reason: "notFound" }, replacing: [] })).toEqual({
			kind: "blocked",
			reason: "notFound"
		})
	})
})

describe("stepAfterSize", () => {
	it("warns before a directory large enough to strain memory, and saves anything smaller or unknown", () => {
		expect(stepAfterSize({ uuid: "a", replace: ["b"], entries: ROOT_ENTRIES_LARGE })).toEqual({
			kind: "large",
			uuid: "a",
			replace: ["b"],
			entries: ROOT_ENTRIES_LARGE
		})
		expect(stepAfterSize({ uuid: "a", replace: [], entries: ROOT_ENTRIES_LARGE - 1 })).toEqual({ kind: "saving" })
		expect(stepAfterSize({ uuid: "a", replace: [], entries: null })).toEqual({ kind: "saving" })
	})
})

describe("addRootEdit", () => {
	it("adds the directory and removes the ones it replaces", () => {
		const stamp = { t: 10, d: "w" }
		const doc = withLibraryRoot({ doc: emptyLibraryConfig(), dirUuid: "movies", stamp: { t: 1, d: "w" }, now: 1 })
		const next = addRootEdit({ uuid: "4k", replace: ["movies"], now: 5 })(doc, stamp)

		expect(activeLibraryRoots(next).map(entry => [entry.dirUuid, entry.type, entry.enabled])).toEqual([["4k", "auto", true]])
	})

	it("never removes the directory it adds", () => {
		const doc = withLibraryRoot({ doc: emptyLibraryConfig(), dirUuid: "movies", stamp: { t: 1, d: "w" }, now: 1 })
		const next = addRootEdit({ uuid: "movies", replace: ["movies"], now: 5 })(doc, { t: 10, d: "w" })

		expect(activeLibraryRoots(next).map(entry => entry.dirUuid)).toEqual(["movies"])
	})
})
