import { describe, expect, it } from "vitest"
import { createEntryStore, ENTRY_CHUNK } from "@/features/archive/lib/entryStore"
import { ENTRY_FLAG, ENTRY_KIND, skipCode, type PackedEntryBatch } from "@/lib/sdk/archiveListing"
import { packEntries, storeOf, TEST_ARCHIVE } from "@/tests/support/archiveEntries"

describe("createEntryStore", () => {
	it("starts with only the root", () => {
		const store = createEntryStore()

		expect(store.archiveUuid).toBe("")
		expect(store.version).toBe(0)
		expect(store.entryCount).toBe(0)
		expect(store.dirCount).toBe(1)
		expect(store.dirParent(0)).toBe(-1)
		expect(store.dirPath(0)).toBe("")
		expect(store.findDir("")).toBe(0)
		expect(store.childDirs(0)).toEqual([])

		for (const batch of packEntries(["x"])) {
			store.append({ ...batch, count: 0 })
		}

		expect(store.version).toBe(0)
	})

	it("synthesises the directories a path implies", () => {
		const store = storeOf(["a/b/c.txt", "a/d.txt"])
		const a = store.findDir("a")
		const b = store.findDir("a/b")

		expect(store.archiveUuid).toBe(TEST_ARCHIVE)
		expect(store.dirCount).toBe(3)
		expect(store.childDirs(0)).toEqual([a])
		expect(store.childDirs(a)).toEqual([b])
		expect(store.dirName(b)).toBe("b")
		expect(store.dirParent(b)).toBe(a)
		expect(store.dirEntrySlot(a)).toBe(-1)
		expect(store.dirModified(a)).toBeNaN()
		expect(store.dirSkip(a)).toBe(0)
		expect(store.dirPath(b)).toBe("a/b")
		expect(store.childEntries(b)).toEqual([0])
		expect(store.childEntries(a)).toEqual([1])
		expect(store.childEntries(0)).toEqual([])
		expect(store.parent(0)).toBe(b)
		expect(store.name(0)).toBe("c.txt")
		expect(store.findDir("a/c")).toBe(-1)
	})

	it("marks an implied directory with an entry stored after its children", () => {
		const store = storeOf(["a/x.txt", { path: "a/", modified: 5, index: 1 }, { path: "e/", index: 2 }])
		const a = store.findDir("a")
		const e = store.findDir("e")

		expect(store.dirEntrySlot(a)).toBe(1)
		expect(store.dirModified(a)).toBe(5)
		expect(store.childEntries(a)).toEqual([0])
		expect(store.childEntries(0)).toEqual([])
		expect(store.childDirs(0)).toEqual([a, e])
		expect(store.kind(1)).toBe(ENTRY_KIND.dir)
		expect(store.parent(1)).toBe(0)
		expect(store.size(1)).toBe(-1)
		// An empty directory entry is selectable on its own.
		expect(store.aggEntries(e)).toBe(1)
		expect(store.aggFiles(e)).toBe(0)
	})

	it("keeps subtree totals without skipped entries, hard links counted as files", () => {
		const store = storeOf([
			{ path: "a/", index: 0 },
			{ path: "a/f", size: 100 },
			{ path: "a/b/g", size: 7 },
			{ path: "a/b/link", size: 7, kind: { type: "hardlink", target: "a/b/g", targetId: { archive: TEST_ARCHIVE, index: 2 } } },
			{ path: "a/b/sym", kind: { type: "symlink", target: "g" }, skip: "symlink", size: 0 },
			{ path: "a/skipped", size: 1000, skip: "unsupportedMethod" },
			{ path: "__MACOSX/", skip: "macMetadata" },
			{ path: "__MACOSX/._f", skip: "macMetadata", size: 4 },
			{ path: "top", size: 1 }
		])
		const a = store.findDir("a")
		const b = store.findDir("a/b")
		const mac = store.findDir("__MACOSX")

		expect([store.aggFiles(b), store.aggBytes(b), store.aggEntries(b)]).toEqual([2, 14, 2])
		expect([store.aggFiles(a), store.aggBytes(a), store.aggEntries(a)]).toEqual([3, 114, 4])
		expect([store.aggFiles(mac), store.aggBytes(mac), store.aggEntries(mac)]).toEqual([0, 0, 0])
		expect(store.dirSkip(mac)).toBe(skipCode("macMetadata"))
		expect([store.aggFiles(0), store.aggBytes(0), store.aggEntries(0)]).toEqual([4, 115, 5])
		expect(store.link(3)).toEqual({ target: "a/b/g", targetIndex: 2 })
		expect(store.link(4)).toEqual({ target: "g", targetIndex: -1 })
		expect(store.link(1)).toBeUndefined()
		expect(store.skip(5)).toBe(skipCode("unsupportedMethod"))
	})

	it("adds totals across batches and keeps duplicate paths", () => {
		const store = storeOf(["d/x", "d/x", "d/y", "d/z"], 2)
		const d = store.findDir("d")

		expect(store.version).toBe(2)
		expect(store.childEntries(d)).toEqual([0, 1, 2, 3])
		expect(store.name(1)).toBe("x")
		expect(store.aggFiles(d)).toBe(4)
		expect(store.aggFiles(0)).toBe(4)
	})

	it("counts a directory stored twice once, the later entry being its own", () => {
		const store = storeOf(["d/", "d/x", { path: "d/", modified: 9, index: 2 }, "e/"], 2)
		const d = store.findDir("d")

		expect(store.dirEntrySlot(d)).toBe(2)
		expect(store.dirModified(d)).toBe(9)
		expect(store.aggEntries(d)).toBe(2)
		expect(store.aggEntries(0)).toBe(3)
		expect(store.childEntries(d)).toEqual([1])
	})

	it("keeps directory spellings that differ only in case as one directory, named by the first", () => {
		const store = storeOf(["Docs/", "Docs/a.txt", "docs/b.txt", "DOCS/Sub/c.txt", "docs/sub/d.txt", { path: "docs/", index: 5 }])
		const docs = store.findDir("Docs")

		expect(store.dirCount).toBe(3)
		expect(store.findDir("docs")).toBe(docs)
		expect(store.findDir("dOcS/SUB")).toBe(store.findDir("Docs/Sub"))
		expect(store.dirName(docs)).toBe("Docs")
		expect(store.dirPath(store.findDir("docs/sub"))).toBe("Docs/Sub")
		expect(store.childEntries(docs)).toEqual([1, 2])
		expect(store.dirEntrySlot(docs)).toBe(5)
		expect(store.aggFiles(docs)).toBe(4)
		expect(store.aggEntries(docs)).toBe(5)
		expect(store.aggEntries(0)).toBe(5)
	})

	it("drops a skipped repeat's count, and counts an unskipped repeat of a skipped one", () => {
		const skippedLater = storeOf(["d/", { path: "d/", index: 1, skip: "macMetadata" }])
		const skippedFirst = storeOf([
			{ path: "d/", skip: "macMetadata" },
			{ path: "d/", index: 1 }
		])

		expect(skippedLater.aggEntries(skippedLater.findDir("d"))).toBe(0)
		expect(skippedLater.aggEntries(0)).toBe(0)
		expect(skippedFirst.aggEntries(skippedFirst.findDir("d"))).toBe(1)
		expect(skippedFirst.aggEntries(0)).toBe(1)
	})

	it("puts a pathless entry at the root under its stored path", () => {
		const store = storeOf([
			{ path: undefined, stored: "../evil", skip: "unsafePath" },
			{ path: undefined, stored: "../dir/", kind: { type: "dir" } }
		])

		expect(store.childEntries(0)).toEqual([0, 1])
		expect(store.name(0)).toBe("../evil")
		expect(store.storedPath(0)).toBe("../evil")
		expect(store.flags(1) & ENTRY_FLAG.pathless).toBe(ENTRY_FLAG.pathless)
		expect(store.dirCount).toBe(1)
		expect(store.aggEntries(0)).toBe(1)
	})

	it("reads across the chunk boundary and offsets links and stored paths per batch", () => {
		const count = ENTRY_CHUNK + 1
		const store = storeOf(
			Array.from({ length: count }, (_, i) =>
				i === ENTRY_CHUNK
					? { path: undefined, stored: "last", kind: { type: "symlink", target: "t" }, skip: "symlink" }
					: { path: `f${String(i)}`, size: i }
			)
		)

		expect(store.entryCount).toBe(count)
		expect(store.version).toBe(2)
		expect(store.size(ENTRY_CHUNK - 1)).toBe(ENTRY_CHUNK - 1)
		expect(store.name(ENTRY_CHUNK - 1)).toBe(`f${String(ENTRY_CHUNK - 1)}`)
		expect(store.index(ENTRY_CHUNK)).toBe(ENTRY_CHUNK)
		expect(store.name(ENTRY_CHUNK)).toBe("last")
		expect(store.link(ENTRY_CHUNK)).toEqual({ target: "t", targetIndex: -1 })
		expect(store.storedPath(ENTRY_CHUNK)).toBe("last")
		expect(store.childEntries(0)).toHaveLength(count)
		expect(store.aggFiles(0)).toBe(ENTRY_CHUNK)
		expect(() => store.size(count + ENTRY_CHUNK)).toThrow()
	})

	it("finds a slot by entry index, in or out of order", () => {
		const inOrder = storeOf(["a", "b", "c"])

		expect(inOrder.slotOfIndex(2)).toBe(2)
		expect(inOrder.slotOfIndex(3)).toBe(-1)
		expect(inOrder.slotOfIndex(-1)).toBe(-1)

		const store = createEntryStore()

		for (const batch of packEntries([
			{ path: "a", index: 0 },
			{ path: "c", index: 5 },
			{ path: "b", index: 1 }
		])) {
			store.append(batch)
		}

		expect(store.slotOfIndex(0)).toBe(0)
		expect(store.slotOfIndex(5)).toBe(1)
		expect(store.slotOfIndex(1)).toBe(2)
		expect(store.slotOfIndex(3)).toBe(-1)

		for (const batch of packEntries([
			{ path: "z", index: 9 },
			{ path: "y", index: 3 }
		])) {
			store.append(batch)
		}

		expect(store.slotOfIndex(9)).toBe(3)
		expect(store.slotOfIndex(3)).toBe(4)
		expect(store.slotOfIndex(5)).toBe(1)
	})

	it("takes 250k entries in a few hundred directories", () => {
		const total = 250_000
		const perDir = 500
		const batches: PackedEntryBatch[] = []

		for (let start = 0; start < total; start += 4096) {
			const count = Math.min(4096, total - start)
			const parents: string[] = []
			const parentOf = new Map<string, number>()
			const parent = new Uint32Array(count)
			const name: string[] = []

			for (let i = 0; i < count; i++) {
				const slot = start + i
				const dir = Math.floor(slot / perDir)
				const path = `top${String(dir % 10)}/dir${String(dir)}`
				let p = parentOf.get(path)

				if (p === undefined) {
					p = parents.length

					parents.push(path)
					parentOf.set(path, p)
				}

				parent[i] = p
				name.push(`file ${String(slot)}.txt`)
			}

			batches.push({
				archive: TEST_ARCHIVE,
				count,
				index: Uint32Array.from({ length: count }, (_, i) => start + i),
				kind: new Uint8Array(count),
				skip: new Uint8Array(count),
				flags: new Uint8Array(count),
				size: new Float64Array(count).fill(10),
				modified: new Float64Array(count).fill(NaN),
				name,
				parent,
				parents,
				links: [],
				stored: []
			})
		}

		const store = createEntryStore()

		for (const batch of batches) {
			store.append(batch)
		}

		expect(store.entryCount).toBe(total)
		expect(store.dirCount).toBe(1 + 10 + total / perDir)
		expect(store.aggFiles(0)).toBe(total)
		expect(store.aggBytes(0)).toBe(total * 10)
		expect(store.aggEntries(store.findDir("top3"))).toBe(total / 10)
		expect(store.slotOfIndex(total - 1)).toBe(total - 1)
	})
})
