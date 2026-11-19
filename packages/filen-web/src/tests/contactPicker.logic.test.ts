import { describe, expect, it } from "vitest"
import { resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockContact } from "@/tests/support/contactFixtures"

describe("resolveSelectedContacts", () => {
	it("returns only the selected contacts, in source-list order", () => {
		const a = mockContact({ uuid: testUuid("a") })
		const b = mockContact({ uuid: testUuid("b") })
		const c = mockContact({ uuid: testUuid("c") })

		const resolved = resolveSelectedContacts([a, b, c], new Set([c.uuid, a.uuid]))

		expect(resolved).toEqual([a, c])
	})

	it("returns an empty array when nothing is selected — the picker's submit-disabled gate", () => {
		const a = mockContact({ uuid: testUuid("a") })

		expect(resolveSelectedContacts([a], new Set())).toEqual([])
	})

	it("drops a selected uuid no longer present in the contact list", () => {
		const a = mockContact({ uuid: testUuid("a") })

		expect(resolveSelectedContacts([a], new Set([a.uuid, testUuid("ghost")]))).toEqual([a])
	})
})
