// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import type { Contact } from "@filen/sdk-rs"
import "@/lib/i18n"
import { ContactRow, ContactActions } from "@/features/contacts/components/contactRow"

afterEach(() => {
	cleanup()
})

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		userId: 1n,
		email: "alice@filen.io",
		nickName: "Alice",
		lastActive: BigInt(Date.now()),
		timestamp: 1_700_000_000_000n,
		publicKey: "alice-public-key",
		...overrides
	}
}

// new#10 — the contact-avatar presence badge was removed; a contact row must never render one,
// regardless of how recent lastActive is (the badge used to key off exactly this field).
describe("ContactRow — presence badge removed", () => {
	it("renders no avatar-badge element even for a lastActive well inside the old 5-minute presence window", () => {
		const { container } = render(createElement(ContactRow, { contact: mockContact() }))

		expect(container.querySelector('[data-slot="avatar-badge"]')).toBeNull()
	})
})

// M16 — the row menu now offers a "Message" action ahead of Remove/Block; this asserts only the
// UI-level wiring (the click reports the contact upward), not the create-chat + navigate orchestration
// itself (covered by contactsActions.test.ts's messageContact tests).
describe("ContactActions — Message menu item", () => {
	it("renders Message before Remove and Block, and reports the contact via onMessage when clicked", () => {
		const contact = mockContact()
		const onMessage = vi.fn()
		const onRemove = vi.fn()
		const onBlock = vi.fn()

		render(
			createElement(ContactActions, {
				contact,
				onMessage,
				onRemove,
				onBlock
			})
		)

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))

		const items = screen.getAllByRole("menuitem")
		expect(items.map(item => item.textContent)).toEqual(["Message", "Remove", "Block"])

		fireEvent.click(screen.getByRole("menuitem", { name: "Message" }))

		expect(onMessage).toHaveBeenCalledExactlyOnceWith(contact)
		expect(onRemove).not.toHaveBeenCalled()
		expect(onBlock).not.toHaveBeenCalled()
	})

	it("disables the Message item (with the offline title) when disabled is set, same as Remove/Block", () => {
		render(
			createElement(ContactActions, {
				contact: mockContact(),
				onMessage: vi.fn(),
				onRemove: vi.fn(),
				onBlock: vi.fn(),
				disabled: true,
				title: "You're offline"
			})
		)

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))

		const message = screen.getByRole("menuitem", { name: "Message" })
		expect(message.getAttribute("aria-disabled")).toBe("true")
		expect(message.getAttribute("title")).toBe("You're offline")
	})
})
