import { describe, expect, it } from "vitest"
import type { ArchiveEntry, ArchiveEntryKind, ListedSkipReason } from "@filen/sdk-rs"
import { createListBatcher } from "@/workers/archiveListPacker"
import { ENTRY_FLAG, ENTRY_KIND, SKIP_REASONS, skipCode, skipReasonOf, type PackedEntryBatch } from "@/lib/sdk/archiveListing"
import { testUuid } from "@/tests/support/uuid"

const ARCHIVE = testUuid("archive")

type EntryOverrides = Partial<Omit<ArchiveEntry, "modified">> & { modified?: bigint | undefined }

function entry(index: number, path: string | undefined, overrides: EntryOverrides = {}): ArchiveEntry {
	const { modified = 1700000000000n, ...rest } = overrides

	return {
		id: { archive: ARCHIVE, index },
		storedPath: path ?? `stored-${String(index)}`,
		storedPathTruncated: false,
		path: path === undefined ? undefined : { path, rewritten: false, misleading: false },
		kind: { type: "file" },
		size: 10n,
		...("modified" in overrides && overrides.modified === undefined ? {} : { modified }),
		encrypted: false,
		method: undefined,
		skip: undefined,
		macMetadata: false,
		...rest
	}
}

function packed(entries: ArchiveEntry[], flushAt?: number): PackedEntryBatch[] {
	const batches: PackedEntryBatch[] = []
	const batcher = createListBatcher(batch => {
		batches.push(batch)
	}, flushAt)

	batcher.push(entries)
	batcher.flush()

	return batches
}

function only(batches: PackedEntryBatch[]): PackedEntryBatch {
	const [batch] = batches

	if (batch === undefined || batches.length !== 1) {
		throw new Error(`expected one batch, got ${String(batches.length)}`)
	}

	return batch
}

describe("createListBatcher", () => {
	it("packs kinds, sizes, dates and flags", () => {
		const kinds: ArchiveEntryKind[] = [
			{ type: "file" },
			{ type: "dir" },
			{ type: "symlink", target: "../t" },
			{ type: "hardlink", target: "a/t", targetId: { archive: ARCHIVE, index: 0 } },
			{ type: "device" },
			{ type: "other" }
		]
		const batch = only(
			packed([
				...kinds.map((kind, i) => entry(i, `e${String(i)}`, { kind })),
				entry(6, "d/", { kind: { type: "dir" }, size: undefined, modified: undefined }),
				entry(7, "enc", { encrypted: true, macMetadata: true }),
				entry(8, "odd", {
					path: { path: "odd", rewritten: true, misleading: true },
					storedPath: "od:d",
					storedPathTruncated: true
				}),
				entry(9, "x", { kind: { type: "hardlink", target: "gone", targetId: undefined } })
			])
		)

		expect(batch.archive).toBe(ARCHIVE)
		expect(batch.count).toBe(10)
		expect([...batch.index]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect([...batch.kind.subarray(0, 6)]).toEqual([
			ENTRY_KIND.file,
			ENTRY_KIND.dir,
			ENTRY_KIND.symlink,
			ENTRY_KIND.hardlink,
			ENTRY_KIND.device,
			ENTRY_KIND.other
		])
		expect(batch.size[0]).toBe(10)
		expect(batch.size[6]).toBe(-1)
		expect(batch.modified[0]).toBe(1700000000000)
		expect(batch.modified[6]).toBeNaN()
		expect(batch.name[6]).toBe("d")
		expect(batch.flags[7]).toBe(ENTRY_FLAG.encrypted | ENTRY_FLAG.macMetadata)
		expect(batch.flags[8]).toBe(ENTRY_FLAG.rewritten | ENTRY_FLAG.misleading | ENTRY_FLAG.storedTruncated)
		expect(batch.links).toEqual([
			{ i: 2, target: "../t", targetIndex: -1 },
			{ i: 3, target: "a/t", targetIndex: 0 },
			{ i: 9, target: "gone", targetIndex: -1 }
		])
		expect(batch.stored).toEqual([{ i: 8, storedPath: "od:d" }])
	})

	it("codes every skip reason as its position plus one", () => {
		const reasons = SKIP_REASONS.map((type): ListedSkipReason => ({ type }))
		const batch = only(packed([entry(0, "none"), ...reasons.map((skip, i) => entry(i + 1, `s${String(i)}`, { skip }))]))

		expect([...batch.skip]).toEqual([0, ...SKIP_REASONS.map((_, i) => i + 1)])
		expect(skipCode("macMetadata")).toBe(12)
		expect(skipReasonOf(1)).toBe("symlink")
		expect(skipReasonOf(0)).toBeNull()
		expect(skipReasonOf(13)).toBeNull()
	})

	it("dedupes parent paths per flush", () => {
		const batch = only(packed([entry(0, "a/b/1"), entry(1, "top"), entry(2, "a/b/2"), entry(3, "a/3"), entry(4, "a/b/c/")]))

		expect(batch.parents).toEqual(["a/b", "", "a"])
		expect([...batch.parent]).toEqual([0, 1, 0, 2, 0])
		expect(batch.name).toEqual(["1", "top", "2", "3", "c"])
	})

	it("puts a pathless entry at the root under its stored path", () => {
		const batch = only(
			packed([
				entry(0, undefined, { storedPath: "../../etc/passwd", skip: { type: "unsafePath" } }),
				entry(1, "/", { storedPath: "stored-1" })
			])
		)

		expect(batch.parents).toEqual([""])
		expect(batch.name).toEqual(["../../etc/passwd", "stored-1"])
		expect(batch.flags[0]).toBe(ENTRY_FLAG.pathless)
		expect(batch.flags[1]).toBe(ENTRY_FLAG.pathless)
		expect(batch.stored).toEqual([
			{ i: 0, storedPath: "../../etc/passwd" },
			{ i: 1, storedPath: "stored-1" }
		])
	})

	it("posts a batch every flushAt entries, each with its own columns and parents", () => {
		const entries = Array.from({ length: 4097 * 2 }, (_, i) => entry(i, `d${String(i % 3)}/f${String(i)}`))
		const batches: PackedEntryBatch[] = []
		const batcher = createListBatcher(batch => {
			batches.push(batch)
		})

		batcher.push(entries.slice(0, 4095))
		expect(batches).toHaveLength(0)
		expect(batcher.pending()).toBe(4095)

		batcher.push(entries.slice(4095))
		expect(batches.map(batch => batch.count)).toEqual([4096, 4096])
		expect(batcher.pending()).toBe(2)

		batcher.flush()
		batcher.flush()

		expect(batches.map(batch => batch.count)).toEqual([4096, 4096, 2])
		expect(batches[0]?.index.length).toBe(4096)
		expect(batches[1]?.index[0]).toBe(4096)
		expect(batches[0]?.index[0]).toBe(0)
		expect(batches[2]?.parents).toEqual(["d2", "d0"])
		expect(batches[2]?.name).toEqual(["f8192", "f8193"])
		expect(batches[0]?.name).toHaveLength(4096)
	})

	it("posts nothing when empty", () => {
		expect(packed([])).toEqual([])
	})
})
