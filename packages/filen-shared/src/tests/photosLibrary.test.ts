import { describe, expect, it } from "vitest"
import {
	PhotosLibraryVersionError,
	activePhotosRoots,
	emptyPhotosLibrary,
	hasPhotosRootRecords,
	mergePhotosLibrary,
	parsePhotosLibrary,
	photosLibraryMaxStamp,
	samePhotosLibrary,
	serializePhotosLibrary,
	withPhotosRoot,
	withoutPhotosRoot,
	type PhotosLibraryDoc
} from "@filen/shared"

function stamp(t: number, d = "a") {
	return { t, d }
}

function rooted(doc: PhotosLibraryDoc, dirUuid: string, t: number, d = "a"): PhotosLibraryDoc {
	return withPhotosRoot({ doc, dirUuid, stamp: stamp(t, d), now: t })
}

function removed(doc: PhotosLibraryDoc, dirUuid: string, t: number, d = "a"): PhotosLibraryDoc {
	return withoutPhotosRoot({ doc, dirUuid, stamp: stamp(t, d), at: t })
}

function roots(doc: PhotosLibraryDoc): string[] {
	return activePhotosRoots(doc).map(root => root.dirUuid)
}

describe("photos library", () => {
	it("lists roots in the order they were added", () => {
		const doc = rooted(rooted(emptyPhotosLibrary(), "b", 2), "a", 3)

		expect(roots(doc)).toEqual(["b", "a"])
		expect(photosLibraryMaxStamp(doc)).toBe(3)
	})

	it("adding a root twice or removing a missing one changes nothing", () => {
		const doc = rooted(emptyPhotosLibrary(), "a", 1)

		expect(rooted(doc, "a", 2)).toBe(doc)
		expect(removed(doc, "b", 2)).toBe(doc)
	})

	it("concurrent adds on two devices both survive", () => {
		const base = rooted(emptyPhotosLibrary(), "a", 1)
		const left = rooted(base, "b", 2, "left")
		const right = rooted(base, "c", 2, "right")

		expect(roots(mergePhotosLibrary(left, right)).sort()).toEqual(["a", "b", "c"])
		expect(serializePhotosLibrary(mergePhotosLibrary(left, right))).toBe(serializePhotosLibrary(mergePhotosLibrary(right, left)))
	})

	it("a removal is never undone by a merge with a copy that still holds the root", () => {
		const base = rooted(rooted(emptyPhotosLibrary(), "a", 1), "b", 2)
		const removedHere = removed(base, "a", 3, "left")
		const addedThere = rooted(base, "c", 3, "right")

		expect(roots(mergePhotosLibrary(removedHere, addedThere))).toEqual(["b", "c"])
		expect(roots(mergePhotosLibrary(addedThere, removedHere))).toEqual(["b", "c"])
		expect(roots(mergePhotosLibrary(base, removedHere))).toEqual(["b"])
		expect(hasPhotosRootRecords(removed(rooted(emptyPhotosLibrary(), "a", 1), "a", 2))).toBe(true)
	})

	it("a root added again after its removal comes back", () => {
		const doc = rooted(removed(rooted(emptyPhotosLibrary(), "a", 1), "a", 2), "a", 3)

		expect(roots(doc)).toEqual(["a"])
		expect(roots(mergePhotosLibrary(doc, removed(rooted(emptyPhotosLibrary(), "a", 1), "a", 2)))).toEqual(["a"])
	})

	it("returns a side itself when the other adds nothing", () => {
		const a = rooted(emptyPhotosLibrary(), "a", 1)
		const b = rooted(a, "b", 2)

		expect(mergePhotosLibrary(b, a)).toBe(b)
		expect(mergePhotosLibrary(a, b)).toBe(b)
	})

	it("round-trips, carrying fields, registers and records this version doesn't know", () => {
		const text = JSON.stringify({
			v: 1,
			future: { keep: true },
			roots: {
				a: { ad: { t: 1, d: "a", v: 1 }, label: { t: 1, d: "a", v: "Holidays" } },
				bad: "not a record"
			}
		})
		const doc = parsePhotosLibrary(text)

		expect(roots(doc)).toEqual(["a"])
		expect(doc["future"]).toEqual({ keep: true })
		expect(doc.roots["a"]?.["label"]).toEqual({ t: 1, d: "a", v: "Holidays" })

		const next = rooted(doc, "b", 2)
		const reread = parsePhotosLibrary(serializePhotosLibrary(next))

		expect(reread["future"]).toEqual({ keep: true })
		expect(reread.roots["a"]?.["label"]).toEqual({ t: 1, d: "a", v: "Holidays" })
		expect(samePhotosLibrary(reread, next)).toBe(true)
		// Merged with a copy of an older version, the unknown parts stay.
		expect(mergePhotosLibrary(emptyPhotosLibrary(), reread)["future"]).toEqual({ keep: true })
	})

	it("refuses a newer format, reads other JSON as empty, and throws SyntaxError for non-JSON", () => {
		expect(() => parsePhotosLibrary(JSON.stringify({ v: 2, roots: {} }))).toThrow(PhotosLibraryVersionError)
		expect(roots(parsePhotosLibrary("[]"))).toEqual([])
		expect(roots(parsePhotosLibrary(JSON.stringify({ v: "1" })))).toEqual([])
		expect(() => parsePhotosLibrary("{")).toThrow(SyntaxError)
	})

	it("serializes independently of key order", () => {
		const a = rooted(rooted(emptyPhotosLibrary(), "a", 1), "b", 2)
		const b = rooted(rooted(emptyPhotosLibrary(), "b", 2), "a", 1)

		expect(serializePhotosLibrary(a)).toBe(serializePhotosLibrary(b))
	})
})
