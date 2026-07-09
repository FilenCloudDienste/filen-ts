import { describe, expect, it } from "vitest"
import { CheckIcon, XIcon, Trash2Icon, BanIcon, RotateCcwIcon } from "lucide-react"
import { buildContactBulkActions, type ContactBulkCounts } from "@/features/contacts/components/contactsBulkBar.logic"

function counts(overrides: Partial<ContactBulkCounts> = {}): ContactBulkCounts {
	return { requests: 0, pending: 0, contacts: 0, blocked: 0, ...overrides }
}

describe("buildContactBulkActions", () => {
	it("returns nothing for an empty selection", () => {
		expect(buildContactBulkActions(counts())).toEqual([])
	})

	it("orders every group unblock -> accept -> deny -> cancel -> remove -> block when everything is selected", () => {
		const descriptors = buildContactBulkActions(counts({ requests: 1, pending: 1, contacts: 1, blocked: 1 }))

		expect(descriptors.map(d => d.kind)).toEqual(["unblock", "accept", "deny", "cancel", "remove", "block"])
	})

	it("requests-only selection: accept then deny, both carrying the requests count", () => {
		const descriptors = buildContactBulkActions(counts({ requests: 3 }))

		expect(descriptors).toEqual([
			{ kind: "accept", count: 3, labelKey: "contactsActionAccept", icon: CheckIcon },
			{ kind: "deny", count: 3, labelKey: "contactsActionDeny", icon: XIcon }
		])
	})

	it("pending-only selection: cancel alone, carrying the pending count", () => {
		const descriptors = buildContactBulkActions(counts({ pending: 2 }))

		expect(descriptors).toEqual([{ kind: "cancel", count: 2, labelKey: "contactsActionCancelRequest", icon: XIcon }])
	})

	it("contacts-only selection: remove then block, both destructive, carrying the contacts count", () => {
		const descriptors = buildContactBulkActions(counts({ contacts: 4 }))

		expect(descriptors).toEqual([
			{ kind: "remove", count: 4, labelKey: "contactsActionRemove", icon: Trash2Icon, destructive: true },
			{ kind: "block", count: 4, labelKey: "contactsActionBlock", icon: BanIcon, destructive: true }
		])
	})

	it("blocked-only selection: unblock alone, not destructive, carrying the blocked count", () => {
		const descriptors = buildContactBulkActions(counts({ blocked: 5 }))

		expect(descriptors).toEqual([{ kind: "unblock", count: 5, labelKey: "contactsActionUnblock", icon: RotateCcwIcon }])
	})

	it("only remove/block are destructive-styled — every other descriptor omits the flag", () => {
		const descriptors = buildContactBulkActions(counts({ requests: 1, pending: 1, contacts: 1, blocked: 1 }))

		for (const descriptor of descriptors) {
			if (descriptor.kind === "remove" || descriptor.kind === "block") {
				expect(descriptor.destructive).toBe(true)
			} else {
				expect(descriptor.destructive).toBeFalsy()
			}
		}
	})

	it("a section with zero selected contributes no descriptor for that group", () => {
		const descriptors = buildContactBulkActions(counts({ contacts: 2 }))

		expect(descriptors.some(d => d.kind === "unblock" || d.kind === "accept" || d.kind === "deny" || d.kind === "cancel")).toBe(false)
	})
})
