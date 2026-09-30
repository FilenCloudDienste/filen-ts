import { describe, it, expect } from "vitest"
import { upsertItem, upsertItems, removeByUuid, applyMembershipPatch } from "@filen/shared"

function item(uuid: string, name?: string) {
	return { data: { uuid, decryptedMeta: name !== undefined ? { name } : null } }
}

describe("upsertItem", () => {
	function uuidsAfter(existing: ReturnType<typeof item>, incoming: ReturnType<typeof item>): string[] {
		return upsertItem([existing], incoming).map(row => row.data.uuid)
	}

	it("drops the existing row when its uuid matches the incoming item", () => {
		expect(upsertItem([item("same", "a.txt")], item("same", "b.txt"))).toEqual([item("same", "b.txt")])
	})

	it("drops an existing same-name (case/space-insensitive) duplicate with a different uuid", () => {
		expect(uuidsAfter(item("old", "  Notes.TXT "), item("new", "notes.txt"))).toEqual(["new"])
	})

	it("keeps an unrelated decryptable row (different uuid AND different name)", () => {
		expect(uuidsAfter(item("old", "other.txt"), item("new", "notes.txt"))).toEqual(["old", "new"])
	})

	it("keeps an existing undecryptable sibling when the incoming item is also undecryptable", () => {
		// Both names undefined — must NOT be treated as a same-name collision.
		expect(uuidsAfter(item("undec-a"), item("incoming"))).toEqual(["undec-a", "incoming"])
	})

	it("keeps an existing undecryptable sibling when the incoming item is decryptable", () => {
		expect(uuidsAfter(item("undec-a"), item("incoming", "notes.txt"))).toEqual(["undec-a", "incoming"])
	})

	it("keeps a decryptable row when the incoming item is undecryptable (name undefined)", () => {
		expect(uuidsAfter(item("old", "notes.txt"), item("incoming"))).toEqual(["old", "incoming"])
	})
})

describe("upsertItems", () => {
	function sequential<T extends ReturnType<typeof item>>(items: T[], incoming: T[]): T[] {
		return incoming.reduce((list, next) => upsertItem(list, next), items)
	}

	it("matches upsertItem applied to each incoming item in turn", () => {
		const items = [item("a", "a.txt"), item("b", "B.txt"), item("u1"), item("c", "c.txt")]
		const incoming = [item("n1", " b.TXT"), item("a", "renamed.txt"), item("n2", "b.txt"), item("u2"), item("n3", "fresh.txt")]

		expect(upsertItems(items, incoming)).toEqual(sequential(items, incoming))
		expect(upsertItems(items, incoming).map(row => row.data.uuid)).toEqual(["u1", "c", "a", "n2", "u2", "n3"])
	})

	it("keeps only the last of several incoming items sharing a uuid", () => {
		const first = item("x", "one.txt")
		const last = item("x", "two.txt")

		expect(upsertItems([], [first, last])).toEqual([last])
	})

	it("never collapses undecryptable rows into one another", () => {
		const items = [item("u1"), item("u2")]

		expect(upsertItems(items, [item("u3")]).map(row => row.data.uuid)).toEqual(["u1", "u2", "u3"])
	})

	it("returns the same listing when nothing comes in", () => {
		const items = [item("a", "a.txt")]

		expect(upsertItems(items, [])).toBe(items)
	})
})

describe("upsertItem", () => {
	it("replaces an existing row with the same uuid", () => {
		const items = [item("a", "old.txt"), item("b", "other.txt")]
		const incoming = item("a", "new.txt")

		expect(upsertItem(items, incoming)).toEqual([item("b", "other.txt"), incoming])
	})

	it("replaces a same-name duplicate under a different uuid", () => {
		const items = [item("a", "notes.txt")]
		const incoming = item("b", "Notes.TXT")

		expect(upsertItem(items, incoming)).toEqual([incoming])
	})

	it("appends when nothing collides", () => {
		const items = [item("a", "notes.txt")]
		const incoming = item("b", "other.txt")

		expect(upsertItem(items, incoming)).toEqual([item("a", "notes.txt"), incoming])
	})
})

describe("removeByUuid", () => {
	it("drops the row with the matching uuid", () => {
		expect(removeByUuid([item("a"), item("b")], "a")).toEqual([item("b")])
	})

	it("leaves the list unchanged when no row matches", () => {
		const items = [item("a"), item("b")]

		expect(removeByUuid(items, "z")).toEqual(items)
	})
})

describe("applyMembershipPatch", () => {
	it("adds the item, deduping by uuid alone, when isMember is true", () => {
		const items = [item("a", "same-name")]
		const incoming = item("b", "same-name")

		expect(applyMembershipPatch(items, incoming, true)).toEqual([item("a", "same-name"), incoming])
	})

	it("replaces an existing row with the same uuid when isMember is true", () => {
		const items = [item("a", "old.txt")]
		const incoming = item("a", "new.txt")

		expect(applyMembershipPatch(items, incoming, true)).toEqual([incoming])
	})

	it("removes the item by uuid when isMember is false", () => {
		const items = [item("a"), item("b")]

		expect(applyMembershipPatch(items, item("a"), false)).toEqual([item("b")])
	})

	it("moves a refreshed member to the end", () => {
		const incoming = item("b", "new.txt")

		expect(applyMembershipPatch([item("a"), item("b", "old.txt"), item("c")], incoming, true)).toEqual([item("a"), item("c"), incoming])
	})

	it("does not mutate the input list", () => {
		const items = [item("a")]

		applyMembershipPatch(items, item("b"), true)
		applyMembershipPatch(items, item("a"), false)

		expect(items).toEqual([item("a")])
	})
})
