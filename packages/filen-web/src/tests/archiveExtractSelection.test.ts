import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, ArchiveFormat, UuidStr } from "@filen/sdk-rs"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { DriveItem } from "@/features/drive/lib/item"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListSummary } from "@/features/archive/lib/listingSession"
import { EMPTY_SELECTION, selectAll, setMany, toggle, type Selection } from "@/features/archive/lib/selection"
import { dirRef } from "@/features/archive/lib/sortedChildren"
import { ENTRY_FLAG } from "@/lib/sdk/archiveListing"
import { i18n } from "@/lib/i18n"
import { packEntries, storeOf, TEST_ARCHIVE, type EntrySpec } from "@/tests/support/archiveEntries"

const { startExtractWithCard, cachedDirectoryName } = vi.hoisted(() => ({
	startExtractWithCard: vi.fn<(request: unknown, password: string | undefined) => string>(() => "job"),
	cachedDirectoryName: vi.fn<(uuid: string) => string | undefined>()
}))

vi.mock("@/features/transfers/lib/archiveToast", () => ({ startExtractWithCard }))
vi.mock("@/features/drive/queries/drive", () => ({
	cachedDirectoryName,
	normalizeParentUuid: (parent: string | null, root: string) => (parent === root ? null : parent)
}))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-uuid" }))

const {
	commonBaseDir,
	fullExtractRequest,
	resolveSelection,
	selectionExtractRequest,
	selectionNeedsPassword,
	startBrowserExtract,
	targetDestination
} = await import("@/features/archive/lib/extractSelection")
const { archiveSourceOf } = await import("@/features/archive/lib/archiveSource")

type Entries = Extract<ReturnType<typeof resolveSelection>, { kind: "entries" }>

function entries(resolved: ReturnType<typeof resolveSelection>): Entries {
	if (resolved.kind !== "entries") {
		throw new Error("expected entries")
	}

	return resolved
}

function dirOf(store: EntryStore, path: string): number {
	const id = store.findDir(path)

	if (id < 0) {
		throw new Error(`no directory ${path}`)
	}

	return id
}

function select(store: EntryStore, refs: number[]): Selection {
	return setMany(store, EMPTY_SELECTION, refs, true)
}

function hardlink(path: string, index: number, target: number): EntrySpec {
	return { path, index, size: 4, kind: { type: "hardlink", target: "t", targetId: { archive: TEST_ARCHIVE, index: target } } }
}

const ARCHIVE_UUID = TEST_ARCHIVE as UuidStr

const SOURCE: ArchiveSource = {
	file: { uuid: ARCHIVE_UUID } as unknown as AnyFile,
	uuid: ARCHIVE_UUID,
	name: "photos.zip",
	size: 1000,
	ownParent: "parent-uuid"
}

const INFO: ArchiveNameInfo = { format: { type: "zip" }, defaultName: "photos" }

function summary(format: ArchiveFormat | null, password: ListSummary["password"] = "notNeeded"): ListSummary {
	return {
		format,
		password,
		totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
		undelivered: 0,
		duplicates: null,
		unaccountedBytes: 0,
		verifying: false,
		verifyWaiting: false,
		verifyError: null
	}
}

const DESTINATION = { uuid: "dest-uuid", name: "Dest" }

beforeEach(() => {
	startExtractWithCard.mockClear()
	cachedDirectoryName.mockReset()
})

describe("resolveSelection", () => {
	// 0 a/ · 1 a/x (3) · 2 a/b/ · 3 a/b/y (5) · 4 top (7)
	const zipSpecs: EntrySpec[] = [
		{ path: "a/", index: 0 },
		{ path: "a/x", index: 1, size: 3 },
		{ path: "a/b/", index: 2 },
		{ path: "a/b/y", index: 3, size: 5 },
		{ path: "top", index: 4, size: 7 }
	]

	it("names only a zip directory's own entry when it is selected whole", () => {
		const store = storeOf(zipSpecs)
		const resolved = entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "a"))]), 0, "zip"))

		expect(resolved.indexes).toEqual([0])
		expect(resolved.files).toBe(2)
		expect(resolved.bytes).toBe(8)
		expect(resolved.linkTargetsAdded).toBe(0)
	})

	it("names every entry below a directory the paths only imply", () => {
		const store = storeOf([
			{ path: "a/x", size: 3 },
			{ path: "a/b/y", size: 5 },
			{ path: "a/b/", index: 2 }
		])
		const resolved = entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "a"))]), 0, "sevenZ"))

		// a/b has its own entry, which brings a/b/y.
		expect(resolved.indexes).toEqual([0, 2])
		expect(resolved.files).toBe(2)
	})

	it("never names a directory's entry when something below it is left out", () => {
		const store = storeOf(zipSpecs)
		const a = dirRef(dirOf(store, "a"))
		const resolved = entries(resolveSelection(store, toggle(store, select(store, [a]), 3), 0, "zip"))

		// a/ would bring a/b/y; a/b/ too.
		expect(resolved.indexes).toEqual([1])
		expect(resolved.files).toBe(1)
		expect(resolved.bytes).toBe(3)
	})

	it("names a tar directory with only the descendants it stores before itself", () => {
		const store = storeOf([
			{ path: "a/b/", index: 0 },
			{ path: "a/early", index: 1, size: 2 },
			{ path: "a/", index: 2 },
			{ path: "a/b/c", index: 3, size: 4 },
			{ path: "a/late", index: 4, size: 8 },
			{ path: "a/d/", index: 5 },
			{ path: "a/d/e", index: 6, size: 1 }
		])
		const resolved = entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "a"))]), 0, "tar"))

		// a/ (2) brings 3–6; a/b/ (0) and a/early (1) come before it.
		expect(resolved.indexes).toEqual([0, 1, 2])
		expect(resolved.files).toBe(4)
		expect(resolved.bytes).toBe(15)
	})

	it("resolves a directory stored in several spellings as the SDK does, one directory under the first", () => {
		// 0 Docs/ · 1 Docs/a (2) · 2 docs/b (4) · 3 docs/c (8)
		const store = storeOf([
			{ path: "Docs/", index: 0 },
			{ path: "Docs/a", index: 1, size: 2 },
			{ path: "docs/b", index: 2, size: 4 },
			{ path: "docs/c", index: 3, size: 8 }
		])
		const docs = dirOf(store, "Docs")

		expect(store.findDir("docs")).toBe(docs)

		// Whole, its entry brings every spelling's contents, which the figures count.
		const whole = entries(resolveSelection(store, select(store, [dirRef(docs)]), 0, "zip"))

		expect(whole.indexes).toEqual([0])
		expect(whole.files).toBe(3)
		expect(whole.bytes).toBe(14)

		// With docs/c left out, its entry would still bring it: each other entry is named instead.
		const partial = entries(resolveSelection(store, toggle(store, select(store, [dirRef(docs)]), 3), 0, "zip"))

		expect(partial.indexes).toEqual([1, 2])
		expect(partial.files).toBe(2)
		expect(partial.bytes).toBe(6)
	})

	it("names each selected tar entry when a directory has an exclusion", () => {
		const store = storeOf([
			{ path: "a/", index: 0 },
			{ path: "a/x", index: 1, size: 1 },
			{ path: "a/y", index: 2, size: 2 },
			{ path: "a/z/", index: 3 },
			{ path: "a/z/w", index: 4, size: 4 }
		])
		const a = dirRef(dirOf(store, "a"))
		const resolved = entries(resolveSelection(store, toggle(store, select(store, [a]), 2), 0, "tar"))

		expect(resolved.indexes).toEqual([1, 3])
		expect(resolved.files).toBe(2)
		expect(resolved.bytes).toBe(5)
	})

	it("reads an unknown format by the tar rules", () => {
		const store = storeOf([
			{ path: "a/x", index: 0, size: 1 },
			{ path: "a/", index: 1 }
		])

		expect(entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "a"))]), 0, null)).indexes).toEqual([0, 1])
	})

	it("never names the base directory's own entry", () => {
		const store = storeOf(zipSpecs)
		const a = dirOf(store, "a")
		const resolved = entries(resolveSelection(store, selectAll(store, a), a, "zip"))

		expect(resolved.indexes).toEqual([1, 2])
		expect(resolved.files).toBe(2)
	})

	it("extracts everything when the whole root of a complete listing is selected", () => {
		const store = storeOf(zipSpecs)

		expect(resolveSelection(store, selectAll(store, 0), 0, "zip")).toEqual({ kind: "all" })
		// A stopped listing's rows are not the whole archive.
		expect(entries(resolveSelection(store, selectAll(store, 0), 0, "zip", false)).indexes).toEqual([0, 4])
		// With anything left out, the entries are named.
		expect(resolveSelection(store, toggle(store, selectAll(store, 0), 4), 0, "zip").kind).toBe("entries")
	})

	it("skips skipped entries", () => {
		const store = storeOf([
			{ path: "a/x", size: 1 },
			{ path: "a/._x", size: 1, skip: "macMetadata" }
		])

		expect(entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "a"))]), 0, "zip")).indexes).toEqual([0])
	})

	it("adds a selected hard link's target chain once", () => {
		const store = storeOf([
			{ path: "data/t", index: 0, size: 10 },
			hardlink("data/l1", 1, 0),
			hardlink("sel/l2", 2, 1),
			hardlink("sel/l3", 3, 1)
		])
		const resolved = entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "sel"))]), 0, "tar"))

		expect(resolved.indexes).toEqual([0, 1, 2, 3])
		expect(resolved.linkTargetsAdded).toBe(2)
		expect(resolved.files).toBe(4)
		expect(resolved.bytes).toBe(22)
		expect(resolved.outsideBase).toEqual([])
	})

	it("doesn't add a target the selection already holds, and survives a cycle", () => {
		const store = storeOf([hardlink("a/l1", 0, 1), hardlink("a/l2", 1, 0)])
		const resolved = entries(resolveSelection(store, select(store, [0, 1]), 0, "tar"))

		expect(resolved.indexes).toEqual([0, 1])
		expect(resolved.linkTargetsAdded).toBe(0)
	})

	it("names the entries in ascending index order, whatever order they arrived in", () => {
		const store = storeOf([
			{ path: "d/z", index: 7, size: 1 },
			{ path: "d/a", index: 2, size: 1 },
			{ path: "top", index: 0, size: 1 },
			{ path: "d/m", index: 5, size: 1 },
			{ path: "left out", index: 9, size: 1 }
		])
		const resolved = entries(resolveSelection(store, select(store, [dirRef(dirOf(store, "d")), 2]), 0, "tar"))

		expect(resolved.indexes).toEqual([0, 2, 5, 7])
	})

	it("reports targets outside the base and the links needing them", () => {
		const store = storeOf([{ path: "data/t", index: 0, size: 10 }, hardlink("sel/l", 1, 0), { path: "sel/f", index: 2, size: 1 }])
		const sel = dirOf(store, "sel")
		const selection = selectAll(store, sel)
		const resolved = entries(resolveSelection(store, selection, sel, "tar"))

		expect(resolved.outsideBase).toEqual([0])
		expect(resolved.outsideLinks).toEqual([1])
		expect(commonBaseDir(store, sel, resolved.outsideBase)).toBe(0)

		// Leave them out.
		const without = entries(resolveSelection(store, setMany(store, selection, resolved.outsideLinks, false), sel, "tar"))

		expect(without.indexes).toEqual([2])
		expect(without.outsideBase).toEqual([])

		// Extract from the common parent instead: the target comes along.
		const rebased = entries(resolveSelection(store, selection, 0, "tar"))

		expect(rebased.indexes).toEqual([0, 1, 2])
		expect(rebased.outsideBase).toEqual([])
		expect(rebased.linkTargetsAdded).toBe(1)
	})

	it("finds the nearest common directory", () => {
		const store = storeOf(["x/y/a", "x/z/b", "x/y/w/c"])
		const yw = dirOf(store, "x/y/w")

		expect(commonBaseDir(store, yw, [1])).toBe(dirOf(store, "x"))
		expect(commonBaseDir(store, yw, [0])).toBe(dirOf(store, "x/y"))
		expect(commonBaseDir(store, yw, [99])).toBe(yw)
	})

	it("tells whether the selection holds an encrypted entry", () => {
		const [batch] = packEntries([
			{ path: "a/", index: 0 },
			{ path: "a/secret", index: 1 },
			{ path: "plain", index: 2 }
		])

		if (batch === undefined) {
			throw new Error("no batch")
		}

		batch.flags[1] = ENTRY_FLAG.encrypted

		const store = storeOf([])

		store.append(batch)

		const a = dirRef(dirOf(store, "a"))

		expect(entries(resolveSelection(store, select(store, [a]), 0, "zip")).encrypted).toBe(true)
		expect(entries(resolveSelection(store, select(store, [2]), 0, "zip")).encrypted).toBe(false)

		const withSecret = resolveSelection(store, select(store, [a]), 0, "zip")

		expect(selectionNeedsPassword(withSecret, summary({ type: "zip" }, "required"), undefined)).toBe(true)
		expect(selectionNeedsPassword(withSecret, summary({ type: "zip" }, "wrong"), undefined)).toBe(true)
		expect(selectionNeedsPassword(withSecret, summary({ type: "zip" }, "required"), "pw")).toBe(false)
		expect(selectionNeedsPassword(withSecret, summary({ type: "zip" }, "right"), undefined)).toBe(false)
		expect(
			selectionNeedsPassword(resolveSelection(store, select(store, [2]), 0, "zip"), summary({ type: "zip" }, "required"), undefined)
		).toBe(false)
	})
})

describe("extract requests", () => {
	// 0 a/ · 1 a/b/x (3) · 2 a/b/y (4)
	function plan(): { store: EntryStore; b: number; resolved: Entries } {
		const store = storeOf([
			{ path: "a/", index: 0 },
			{ path: "a/b/x", index: 1, size: 3 },
			{ path: "a/b/y", index: 2, size: 4 }
		])
		const b = dirOf(store, "a/b")
		const resolved = entries(resolveSelection(store, select(store, [1, 2]), b, "zip"))

		return { store, b, resolved }
	}

	it("extracts a selection into a new directory named after the base, with planned figures", () => {
		const { store, b, resolved } = plan()
		const request = selectionExtractRequest(
			{
				source: SOURCE,
				info: INFO,
				summary: summary({ type: "zip" }),
				target: { type: "besideNewFolder" },
				destination: DESTINATION
			},
			store,
			resolved,
			b
		)

		expect(request).toEqual({
			archive: { file: SOURCE.file, uuid: ARCHIVE_UUID, name: "photos.zip" },
			destination: DESTINATION,
			root: { type: "newFolder", name: "b" },
			rowName: "b",
			glyph: "directory",
			calls: [
				{
					type: "entries",
					entries: [
						{ archive: ARCHIVE_UUID, index: 1 },
						{ archive: ARCHIVE_UUID, index: 2 }
					],
					base: "a/b",
					destination: { uuid: "dest-uuid" }
				}
			],
			skipMacMetadata: true,
			dispose: null,
			basis: { type: "planned", bytes: 7, files: 2 },
			formatHint: "zip"
		})
	})

	it("names the new directory after the archive at its root", () => {
		const store = storeOf([{ path: "x", size: 1 }])
		const resolved = entries(resolveSelection(store, select(store, [0]), 0, "zip"))
		const request = selectionExtractRequest(
			{
				source: SOURCE,
				info: INFO,
				summary: null,
				target: { type: "directory", destination: DESTINATION },
				destination: DESTINATION
			},
			store,
			resolved,
			0
		)

		expect(request.root).toEqual({ type: "newFolder", name: "photos" })
		expect(request.calls[0]).toMatchObject({ base: "" })
		// No listing format: the name's.
		expect(request.formatHint).toBe("zip")
	})

	it("extracts next to the archive straight into its directory", () => {
		const { store, b, resolved } = plan()
		const request = selectionExtractRequest(
			{ source: SOURCE, info: INFO, summary: summary({ type: "sevenZ" }), target: { type: "beside" }, destination: DESTINATION },
			store,
			resolved,
			b
		)

		expect(request.root).toEqual({ type: "destination" })
		expect(request.rowName).toBe("photos.zip")
		expect(request.glyph).toBe("items")
		// The bytes decide over the name.
		expect(request.formatHint).toBe("sevenZ")
	})

	it("leaves a single compressed file by its name to the SDK, which ignores the new directory for a real one", () => {
		const request = fullExtractRequest({
			source: { ...SOURCE, name: "notes.txt.gz" },
			info: { format: { type: "single", codec: "gzip" }, defaultName: "notes.txt" },
			summary: null,
			target: { type: "besideNewFolder" },
			destination: DESTINATION
		})

		expect(request.root).toEqual({ type: "newFolder" })
		expect(request.rowName).toBe("notes.txt")
		expect(request.glyph).toBe("file")
		expect(request.formatHint).toBe("single")
	})

	it("extracts the whole archive by its read bytes", () => {
		const request = fullExtractRequest({
			source: SOURCE,
			info: INFO,
			summary: summary({ type: "zip" }),
			target: { type: "directory", destination: DESTINATION },
			destination: DESTINATION
		})

		expect(request).toMatchObject({
			root: { type: "newFolder" },
			rowName: "photos",
			glyph: "directory",
			calls: [{ type: "all" }],
			basis: { type: "archiveRead" },
			skipMacMetadata: true,
			dispose: null
		})
	})

	it("resolves each target's destination", () => {
		const directory = { type: "directory" as const, destination: DESTINATION }

		cachedDirectoryName.mockReturnValue("Photos")

		expect(targetDestination(SOURCE, directory, "My Drive")).toBe(DESTINATION)
		expect(targetDestination(SOURCE, { type: "beside" }, "My Drive")).toEqual({ uuid: "parent-uuid", name: "Photos" })
		expect(targetDestination({ ...SOURCE, ownParent: null }, { type: "besideNewFolder" }, "My Drive")).toEqual({
			uuid: null,
			name: "My Drive"
		})
		// Shared with the user, or in the trash: nothing next to it.
		expect(targetDestination({ ...SOURCE, ownParent: undefined }, { type: "beside" }, "My Drive")).toBeNull()
		expect(targetDestination({ ...SOURCE, ownParent: undefined }, directory, "My Drive")).toBe(DESTINATION)

		cachedDirectoryName.mockReturnValue(undefined)

		expect(targetDestination(SOURCE, { type: "beside" }, "My Drive")).toEqual({
			uuid: "parent-uuid",
			name: i18n.t("drive:driveMoveDestinationFallback")
		})
	})

	it("starts the extract with the password the listing accepted", () => {
		const request = fullExtractRequest({
			source: SOURCE,
			info: INFO,
			summary: null,
			target: { type: "beside" },
			destination: DESTINATION
		})

		expect(startBrowserExtract({ password: () => "secret" }, request)).toBe("job")
		expect(startExtractWithCard).toHaveBeenCalledWith(request, "secret")

		startBrowserExtract({ password: () => undefined }, request)

		expect(startExtractWithCard).toHaveBeenLastCalledWith(request, undefined)
	})
})

describe("archiveSourceOf", () => {
	function file(parent: string, type: "file" | "sharedRootFile" = "file"): DriveItem {
		return {
			type,
			data: { uuid: ARCHIVE_UUID, parent, size: 42n, decryptedMeta: { name: "a.zip" } }
		} as unknown as DriveItem
	}

	it("offers the own directory an archive sits in", () => {
		expect(archiveSourceOf(file("dir-uuid"), "drive")).toMatchObject({
			uuid: ARCHIVE_UUID,
			name: "a.zip",
			size: 42,
			ownParent: "dir-uuid"
		})
		expect(archiveSourceOf(file("root-uuid"), "favorites").ownParent).toBeNull()
		expect(archiveSourceOf(file("dir-uuid"), "recents").ownParent).toBe("dir-uuid")
	})

	it("offers none in the trash, in Shared with me, or without a real parent", () => {
		expect(archiveSourceOf(file("dir-uuid"), "trash").ownParent).toBeUndefined()
		expect(archiveSourceOf(file("dir-uuid", "sharedRootFile"), "sharedIn").ownParent).toBeUndefined()
		expect(archiveSourceOf(file("trash"), "drive").ownParent).toBeUndefined()
		expect(archiveSourceOf(file(ARCHIVE_UUID, "sharedRootFile"), "sharedOut").ownParent).toBeUndefined()
	})

	it("refuses a directory", () => {
		expect(() => archiveSourceOf({ type: "directory", data: {} } as unknown as DriveItem, "drive")).toThrow()
	})
})
