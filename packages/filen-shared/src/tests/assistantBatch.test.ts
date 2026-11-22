import { describe, expect, it } from "vitest"
import { DRIVE_NAME_RULES } from "@filen/shared"
import {
	BATCH_MAX_ITEMS,
	batchDate,
	batchOrganizeCount,
	planBatchRename,
	planOrganizeByDate,
	type BatchItem,
	type BatchRenameRequest
} from "@filen/shared/assistant"

const ZONE = "Europe/Berlin"

function item(id: string, name: string, dates: Partial<BatchItem> = {}): BatchItem {
	return { id, name, parent: "d1", uploaded: Date.UTC(2026, 10, 21, 12), ...dates }
}

function rename(request: Partial<BatchRenameRequest> & Pick<BatchRenameRequest, "items" | "scheme">) {
	const taken = new Map([["d1", request.items.map(entry => entry.name)]])
	const result = planBatchRename({ names: DRIVE_NAME_RULES, taken, timeZone: ZONE, ...request })

	if (!result.ok) {
		throw new Error(result.error)
	}

	return result.plan
}

describe("batchDate", () => {
	it("takes the asked date, else taken, created, modified, then the upload", () => {
		const full = item("f1", "a.jpg", { taken: 1, created: 2, modified: 3 })

		expect(batchDate(full)).toBe(1)
		expect(batchDate(full, "modified")).toBe(3)
		expect(batchDate(item("f1", "a.jpg", { modified: 3 }), "created")).toBe(3)
		expect(batchDate(item("f1", "a.jpg"), "taken")).toBe(Date.UTC(2026, 10, 21, 12))
	})
})

describe("planBatchRename", () => {
	it("puts the ISO day before the name, in the user's zone", () => {
		// 23:30 UTC on the 20th is the 21st in Berlin.
		const plan = rename({ items: [item("f1", "IMG_1.jpg", { taken: Date.UTC(2026, 10, 20, 23, 30) })], scheme: "date_prefix" })

		expect(plan.changes).toEqual([{ id: "f1", parent: "d1", from: "IMG_1.jpg", to: "2026-11-21 IMG_1.jpg", suffixed: false }])
	})

	it("names files by their date, keeping the extension, and suffixes the clashes among the batch's own names", () => {
		const day = { taken: Date.UTC(2026, 0, 5, 10) }
		const plan = rename({ items: [item("f1", "b.jpg", day), item("f2", "a.JPG", day)], scheme: "date_name" })

		expect(plan.changes.map(change => [change.from, change.to, change.suffixed])).toEqual([
			["a.JPG", "2026-01-05.JPG", false],
			["b.jpg", "2026-01-05 (2).jpg", true]
		])
	})

	it("suffixes a name another file of the directory holds, case-insensitively", () => {
		const items = [item("f1", "x.txt")]
		const result = planBatchRename({
			names: DRIVE_NAME_RULES,
			items,
			taken: new Map([["d1", ["x.txt", "Report.txt", "report (2).txt"]]]),
			scheme: "replace_text",
			find: "x",
			text: "report"
		})

		expect(result.ok && result.plan.changes[0]?.to).toBe("report (3).txt")
	})

	it("numbers in natural name order, padded to the count", () => {
		const items = Array.from({ length: 10 }, (_, index) => item(`f${String(index)}`, `p${String(index + 1)}.png`))
		const plan = rename({ items, scheme: "number", text: "Trip" })

		expect(plan.changes[0]).toMatchObject({ from: "p1.png", to: "Trip 01.png" })
		expect(plan.changes[1]).toMatchObject({ from: "p2.png", to: "Trip 02.png" })
		expect(plan.changes[9]).toMatchObject({ from: "p10.png", to: "Trip 10.png" })
	})

	it("adds a prefix or a suffix before the extension, and leaves names that already have it", () => {
		expect(rename({ items: [item("f1", "a.txt"), item("f2", "old_b.txt")], scheme: "add_prefix", text: "old_" }).changes).toEqual([
			{ id: "f1", parent: "d1", from: "a.txt", to: "old_a.txt", suffixed: false }
		])
		expect(rename({ items: [item("f1", "a.tar.gz"), item("f2", ".env")], scheme: "add_suffix", text: "_v2" }).changes).toEqual([
			{ id: "f2", parent: "d1", from: ".env", to: ".env_v2", suffixed: false },
			{ id: "f1", parent: "d1", from: "a.tar.gz", to: "a.tar_v2.gz", suffixed: false }
		])
	})

	it("replaces text in the name only, never the extension; lowercase drops unchanged names", () => {
		expect(rename({ items: [item("f1", "IMG img.img")], scheme: "replace_text", find: "img", text: "Photo" }).changes[0]?.to).toBe(
			"Photo Photo.img"
		)
		expect(rename({ items: [item("f1", "Hello.TXT"), item("f2", "done.txt")], scheme: "lowercase" }).changes).toEqual([
			{ id: "f1", parent: "d1", from: "Hello.TXT", to: "hello.txt", suffixed: false }
		])
	})

	it("skips a name that would hold a path separator or be empty", () => {
		const plan = rename({ items: [item("f1", "a.txt"), item("f2", "b")], scheme: "replace_text", find: "b" })

		expect(plan.changes).toEqual([])
		expect(plan.skipped).toEqual([{ id: "f2", name: "b", reason: "invalid-name" }])
	})

	it("asks for the arguments a scheme needs", () => {
		expect(
			planBatchRename({ names: DRIVE_NAME_RULES, items: [item("f1", "a")], taken: new Map(), scheme: "add_prefix" })
		).toMatchObject({ ok: false, invalid: true })
		expect(
			planBatchRename({ names: DRIVE_NAME_RULES, items: [item("f1", "a")], taken: new Map(), scheme: "replace_text", text: "x" })
		).toMatchObject({
			ok: false
		})
	})

	it("refuses more than the cap instead of cutting", () => {
		const items = Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, index) => item(`f${String(index)}`, `${String(index)}.txt`))

		// A valid call the app refuses: the model is not told to correct it.
		expect(planBatchRename({ names: DRIVE_NAME_RULES, items, taken: new Map(), scheme: "lowercase" })).toMatchObject({
			ok: false,
			invalid: false
		})
	})
})

describe("planOrganizeByDate", () => {
	const may = { taken: Date.UTC(2025, 4, 3, 10) }
	const june = { taken: Date.UTC(2025, 5, 9, 10) }

	it("groups by ISO month, reuses an existing subdirectory and creates the missing one", () => {
		const result = planOrganizeByDate({
			names: DRIVE_NAME_RULES,
			items: [item("f1", "a.jpg", may), item("f2", "b.jpg", june)],
			children: [
				{ id: "f1", name: "a.jpg", directory: false },
				{ id: "f2", name: "b.jpg", directory: false },
				{ id: "d9", name: "2025-05", directory: true }
			],
			destinationNames: new Map([["d9", ["other.jpg"]]]),
			by: "month",
			timeZone: ZONE
		})

		expect(result).toEqual({
			ok: true,
			plan: {
				groups: [
					{ directory: "2025-05", existing: "d9", items: [{ id: "f1", from: "a.jpg" }] },
					{ directory: "2025-06", items: [{ id: "f2", from: "b.jpg" }] }
				],
				skipped: []
			}
		})
	})

	it("renames a move whose name the subdirectory holds, to a name free where it leaves too", () => {
		const result = planOrganizeByDate({
			names: DRIVE_NAME_RULES,
			items: [item("f1", "A.jpg", may), item("f2", "a (2).jpg", june)],
			children: [
				{ id: "f1", name: "A.jpg", directory: false },
				{ id: "f2", name: "a (2).jpg", directory: false },
				{ id: "d9", name: "2025", directory: true }
			],
			destinationNames: new Map([["d9", ["a.jpg"]]]),
			by: "year",
			timeZone: ZONE
		})

		expect(result.ok && result.plan.groups).toEqual([
			{
				directory: "2025",
				existing: "d9",
				items: [
					{ id: "f2", from: "a (2).jpg" },
					{ id: "f1", from: "A.jpg", to: "A (3).jpg" }
				]
			}
		])
		expect(result.ok && batchOrganizeCount(result.plan)).toBe(2)
	})

	it("skips files whose subdirectory name a file holds", () => {
		const result = planOrganizeByDate({
			names: DRIVE_NAME_RULES,
			items: [item("f1", "a.jpg", may)],
			children: [
				{ id: "f1", name: "a.jpg", directory: false },
				{ id: "f7", name: "2025-05-03", directory: false }
			],
			destinationNames: new Map(),
			by: "day",
			timeZone: ZONE
		})

		expect(result).toEqual({ ok: true, plan: { groups: [], skipped: [{ id: "f1", name: "a.jpg", reason: "destination-is-file" }] } })
	})
})
