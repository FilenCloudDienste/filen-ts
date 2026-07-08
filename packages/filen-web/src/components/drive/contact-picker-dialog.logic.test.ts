import { describe, expect, it } from "vitest"
import type { Contact, UuidStr } from "@filen/sdk-rs"
import { resolveSelectedContacts, togglePickerContact } from "@/components/drive/contact-picker-dialog.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockContact(label: string): Contact {
	return {
		uuid: testUuid(label),
		userId: 1n,
		email: `${label}@example.com`,
		nickName: undefined,
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "pk"
	}
}

describe("togglePickerContact", () => {
	it("adds a uuid that is not yet selected", () => {
		const next = togglePickerContact(new Set(), "a")

		expect(next.has("a")).toBe(true)
	})

	it("removes a uuid that is already selected", () => {
		const next = togglePickerContact(new Set(["a"]), "a")

		expect(next.has("a")).toBe(false)
	})

	it("does not mutate the input set (returns a new set)", () => {
		const input = new Set(["a"])
		const next = togglePickerContact(input, "b")

		expect(input.has("b")).toBe(false)
		expect(next).not.toBe(input)
		expect([...next].sort()).toEqual(["a", "b"])
	})

	it("toggling the same uuid twice restores the original membership", () => {
		let selected: ReadonlySet<string> = new Set(["a"])
		selected = togglePickerContact(selected, "b")
		selected = togglePickerContact(selected, "b")

		expect([...selected]).toEqual(["a"])
	})
})

describe("resolveSelectedContacts", () => {
	it("returns only the selected contacts, in source-list order", () => {
		const a = mockContact("a")
		const b = mockContact("b")
		const c = mockContact("c")

		const resolved = resolveSelectedContacts([a, b, c], new Set([c.uuid, a.uuid]))

		expect(resolved).toEqual([a, c])
	})

	it("returns an empty array when nothing is selected — the picker's submit-disabled gate", () => {
		const a = mockContact("a")

		expect(resolveSelectedContacts([a], new Set())).toEqual([])
	})

	it("drops a selected uuid no longer present in the contact list", () => {
		const a = mockContact("a")

		expect(resolveSelectedContacts([a], new Set([a.uuid, testUuid("ghost")]))).toEqual([a])
	})
})
