import { describe, it, expect } from "vitest"
import { keepAgainstIncoming, upsertItem, removeByUuid, applyMembershipPatch } from "@filen/shared"

describe("keepAgainstIncoming", () => {
	it("drops the existing row when its uuid matches the incoming item", () => {
		expect(keepAgainstIncoming("same", "a.txt", "same", "b.txt")).toBe(false)
	})

	it("drops an existing same-name (case/space-insensitive) duplicate with a different uuid", () => {
		expect(keepAgainstIncoming("old", "  Notes.TXT ", "new", "notes.txt")).toBe(false)
	})

	it("keeps an unrelated decryptable row (different uuid AND different name)", () => {
		expect(keepAgainstIncoming("old", "other.txt", "new", "notes.txt")).toBe(true)
	})

	it("keeps an existing undecryptable sibling when the incoming item is also undecryptable", () => {
		// Both names undefined — must NOT be treated as a same-name collision.
		expect(keepAgainstIncoming("undec-a", undefined, "incoming", undefined)).toBe(true)
	})

	it("keeps an existing undecryptable sibling when the incoming item is decryptable", () => {
		expect(keepAgainstIncoming("undec-a", undefined, "incoming", "notes.txt")).toBe(true)
	})

	it("keeps a decryptable row when the incoming item is undecryptable (name undefined)", () => {
		expect(keepAgainstIncoming("old", "notes.txt", "incoming", undefined)).toBe(true)
	})
})

function item(uuid: string, name?: string) {
	return { data: { uuid, decryptedMeta: name !== undefined ? { name } : null } }
}

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
})
