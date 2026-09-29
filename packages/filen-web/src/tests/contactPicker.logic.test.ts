import { describe, expect, it } from "vitest"
import type { Contact } from "@filen/sdk-rs"
import { resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { testUuid } from "@/tests/support/uuid"

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
