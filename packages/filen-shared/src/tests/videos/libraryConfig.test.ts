import { describe, expect, it } from "vitest"
import {
	activeLibraryRoots,
	emptyLibraryConfig,
	libraryConfigMaxStamp,
	libraryOverride,
	libraryPref,
	mergeLibraryConfig,
	parseLibraryConfig,
	parseLibraryConfigText,
	serializeLibraryConfig,
	withLibraryOverride,
	withLibraryPref,
	withLibraryRoot,
	withoutLibraryRoot,
	type LibraryConfigDoc
} from "@filen/shared/videos"

function stamp(t: number, d = "a") {
	return { t, d }
}

function rooted(doc: LibraryConfigDoc, dirUuid: string, t: number, d = "a"): LibraryConfigDoc {
	return withLibraryRoot({ doc, dirUuid, type: "auto", enabled: true, stamp: stamp(t, d), now: t })
}

function merged(local: LibraryConfigDoc, remote: LibraryConfigDoc): LibraryConfigDoc {
	return mergeLibraryConfig({ local, remote }).doc
}

describe("library config parsing", () => {
	it("carries unknown records, registers, values and fields through verbatim", () => {
		const parsed =
			parseLibraryConfig({
				v: 1,
				future: { x: 1 },
				roots: {
					// A root type this version doesn't know: kept as it is, read as auto.
					newer: {
						ty: { t: 1, d: "a", v: "music" },
						en: { t: 1, d: "a", v: true },
						ad: { t: 1, d: "a", v: 5 },
						zz: { t: 1, d: "a", q: 2 }
					},
					junk: "not a record"
				},
				prefs: { sort: { p: { t: 2, d: "a", v: "title" } } },
				overrides: { "d:x": { o: { t: 3, d: "a", title: "Fixed", note: "kept" } } }
			}) ?? emptyLibraryConfig()

		expect(parsed["future"]).toEqual({ x: 1 })
		expect(parsed.roots["newer"]?.["zz"]).toEqual({ t: 1, d: "a", q: 2 })
		expect(parsed.roots["newer"]?.ty?.v).toBe("music")
		expect(Object.keys(parsed.roots)).toEqual(["newer"])
		expect(activeLibraryRoots(parsed)).toEqual([{ dirUuid: "newer", type: "auto", enabled: true, added: 5 }])
		expect(libraryPref(parsed, "sort")).toBe("title")
		expect(libraryOverride(parsed, "d:x")).toMatchObject({ title: "Fixed", note: "kept" })
	})

	it("an older client's edit of a newer entry keeps what it doesn't know", () => {
		const newer =
			parseLibraryConfig({
				v: 1,
				roots: { r: { ty: { t: 1, d: "b", v: "music" }, en: { t: 1, d: "b", v: true }, ad: { t: 1, d: "b", v: 1 } } }
			}) ?? emptyLibraryConfig()
		const edited = withLibraryRoot({ doc: newer, dirUuid: "r", enabled: false, stamp: stamp(5), now: 9 })

		expect(edited.roots["r"]?.ty?.v).toBe("music")
		expect(edited.roots["r"]?.en).toEqual({ t: 5, d: "a", v: false })
		expect(edited.roots["r"]?.ad).toEqual({ t: 1, d: "b", v: 1 })
	})

	it("rejects anything but a version-1 document", () => {
		expect(parseLibraryConfig({ v: 2, roots: {} })).toBeNull()
		expect(parseLibraryConfig([])).toBeNull()
		expect(parseLibraryConfigText("{not json")).toBeNull()
	})
})

describe("library config merge", () => {
	const a = withLibraryPref({
		doc: rooted(emptyLibraryConfig(), "r1", 10, "a"),
		key: "sort",
		value: "title",
		stamp: stamp(11, "a"),
		at: 11
	})
	const b = withLibraryOverride({
		doc: rooted(emptyLibraryConfig(), "r2", 12, "b"),
		key: "d:x",
		override: { title: "X" },
		stamp: stamp(13, "b"),
		at: 13
	})
	const c = withoutLibraryRoot({ doc: rooted(emptyLibraryConfig(), "r1", 10, "a"), dirUuid: "r1", stamp: stamp(20, "c"), at: 20 })

	it("is commutative, associative and idempotent", () => {
		const s = serializeLibraryConfig

		expect(s(merged(a, b))).toBe(s(merged(b, a)))
		expect(s(merged(merged(a, b), c))).toBe(s(merged(a, merged(b, c))))
		expect(s(merged(a, a))).toBe(s(a))
	})

	it("reports which side contributed", () => {
		expect(mergeLibraryConfig({ local: a, remote: a })).toMatchObject({ localContributed: false, remoteContributed: false })
		expect(mergeLibraryConfig({ local: merged(a, b), remote: a })).toMatchObject({ localContributed: true, remoteContributed: false })
	})

	it("keeps a removal over an older copy of the root", () => {
		const both = merged(a, c)

		expect(activeLibraryRoots(both)).toEqual([])
		expect(libraryConfigMaxStamp(both)).toBe(20)
	})

	it("adding a removed root again revives it", () => {
		expect(activeLibraryRoots(rooted(c, "r1", 30)).map(root => root.dirUuid)).toEqual(["r1"])
	})

	it("concurrent edits of different fields of one root both survive", () => {
		const base = rooted(emptyLibraryConfig(), "r", 1)
		const typed = withLibraryRoot({ doc: base, dirUuid: "r", type: "movies", stamp: stamp(5, "a"), now: 5 })
		const disabled = withLibraryRoot({ doc: base, dirUuid: "r", enabled: false, stamp: stamp(6, "b"), now: 6 })

		expect(activeLibraryRoots(merged(typed, disabled))).toEqual([{ dirUuid: "r", type: "movies", enabled: false, added: 1 }])
	})

	it("an edit made after a removal elsewhere survives it", () => {
		const removed = withoutLibraryRoot({ doc: rooted(emptyLibraryConfig(), "r", 1), dirUuid: "r", stamp: stamp(5, "a"), at: 5 })
		const readded = rooted(emptyLibraryConfig(), "r", 9, "b")

		expect(activeLibraryRoots(merged(removed, readded)).map(root => root.dirUuid)).toEqual(["r"])
	})

	it("serializes independent of key order", () => {
		const reordered = { overrides: a.overrides, prefs: a.prefs, roots: a.roots, v: 1 as const }

		expect(serializeLibraryConfig(reordered)).toBe(serializeLibraryConfig(a))
	})
})
