import { beforeEach, describe, expect, it, vi } from "vitest"
import { CONTACTS_ACTIONS } from "@/features/contacts/lib/keymap"
import {
	contactCommandTargets,
	EMPTY_CONTACT_SELECTION,
	isContactSectionKey,
	selectAllContactSections
} from "@/features/contacts/lib/selection"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

beforeEach(() => {
	kvStore.clear()
})

function defaultOf(id: string): string | undefined {
	return CONTACTS_ACTIONS.find(def => def.id === id)?.defaultCombo
}

describe("CONTACTS_ACTIONS", () => {
	it("ships the batch's defaults, with the costly row commands unassigned", () => {
		expect(defaultOf("contacts.selectAll")).toBe("mod+a")
		expect(defaultOf("contacts.search")).toBe("mod+f")
		expect(defaultOf("contacts.add")).toBe("n")
		expect(defaultOf("contacts.message")).toBe("mod+enter")
		expect(defaultOf("contacts.remove")).toBe("delete,backspace")

		for (const id of ["contacts.block", "contacts.accept", "contacts.deny", "contacts.nextSection", "contacts.previousSection"]) {
			expect(defaultOf(id), id).toBe("")
		}
	})

	it("resolves a user override through the registry", async () => {
		vi.resetModules()

		const { registerAction, comboFor, setUserCombo } = await import("@/lib/keymap/registry")

		for (const def of CONTACTS_ACTIONS) {
			registerAction(def)
		}

		await setUserCombo("contacts.block", "mod+shift+b")

		expect(comboFor("contacts.block")).toBe("mod+shift+b")
		expect(comboFor("contacts.remove")).toBe("delete,backspace")
	})
})

describe("contactCommandTargets", () => {
	const items = [{ uuid: "a" }, { uuid: "b" }]

	it("prefers the section's selected rows", () => {
		expect(contactCommandTargets("contacts", 1, { section: "contacts", uuid: "b" }, items, [{ uuid: "a" }])).toEqual([{ uuid: "a" }])
	})

	it("falls back to the focused row of the same section when nothing is selected", () => {
		expect(contactCommandTargets("contacts", 0, { section: "contacts", uuid: "b" }, items, [])).toEqual([{ uuid: "b" }])
		expect(contactCommandTargets("contacts", 0, { section: "requests", uuid: "b" }, items, [])).toEqual([])
		expect(contactCommandTargets("contacts", 0, null, items, [])).toEqual([])
	})

	it("never lets focus override a selection made elsewhere", () => {
		// One row selected, in another section.
		expect(contactCommandTargets("contacts", 1, { section: "contacts", uuid: "a" }, items, [])).toEqual([])
	})
})

describe("selectAllContactSections", () => {
	it("selects every given row and empties the other sections", () => {
		const selection = selectAllContactSections([
			{ key: "contacts", uuids: ["a", "b"] },
			{ key: "requests", uuids: ["r"] }
		])

		expect([...selection.contacts]).toEqual(["a", "b"])
		expect([...selection.requests]).toEqual(["r"])
		expect(selection.blocked.size).toBe(0)
		expect(selection.pending).toBe(EMPTY_CONTACT_SELECTION.pending)
	})

	it("recognizes the section keys only", () => {
		expect(isContactSectionKey("blocked")).toBe(true)
		expect(isContactSectionKey("all")).toBe(false)
	})
})
