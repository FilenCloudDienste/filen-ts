// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { UseQueryResult } from "@tanstack/react-query"
import type { Contact } from "@filen/sdk-rs"
import type { ContactsQueryData } from "@/features/contacts/queries/contacts"

// The contact picker's error state: a failed background refetch keeps the loaded contacts up, a failure with
// nothing loaded offers a retry.

vi.mock("@/features/contacts/components/contactRow", () => ({
	ContactRow: ({ contact }: { contact: Contact }) => createElement("div", { "data-testid": "contact" }, contact.email)
}))
vi.mock("@/features/contacts/components/addContactDialog", () => ({
	AddContactDialog: () => createElement("button", { type: "button" }, "Add contact")
}))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: () => "Network error" }))

import "@/lib/i18n"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { testUuid } from "@/tests/support/uuid"
import { stubElementSize } from "@/tests/stubElementSize"

// The list is virtualized: jsdom lays nothing out, so it gets a box to window over.
let restoreSize: () => void = () => undefined

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 400, clientWidth: 400 })
})

afterAll(() => {
	restoreSize()
})

function contact(label: string, email: string, userId: bigint): Contact {
	return { uuid: testUuid(label), userId, email, nickName: undefined, lastActive: 0n, timestamp: 0n, publicKey: "key" }
}

function successQuery(data: ContactsQueryData): UseQueryResult<ContactsQueryData> {
	return { status: "success", error: null, data, isPending: false, isError: false } as unknown as UseQueryResult<ContactsQueryData>
}

function query(state: { data: ContactsQueryData | undefined; refetch: () => void }): UseQueryResult<ContactsQueryData> {
	return {
		status: "error",
		error: new Error("read failed"),
		data: state.data,
		isPending: false,
		isError: true,
		refetch: state.refetch
	} as unknown as UseQueryResult<ContactsQueryData>
}

function renderPicker(contactsQuery: UseQueryResult<ContactsQueryData>) {
	return render(
		createElement(ContactPickerList, {
			contactsQuery,
			filter: "",
			onFilterChange: vi.fn(),
			selected: new Set<string>(),
			onToggle: vi.fn(),
			ariaLabel: "Contacts",
			emptyTitle: "No contacts"
		})
	)
}

afterEach(() => {
	cleanup()
})

describe("ContactPickerList — load error", () => {
	it("keeps the loaded contacts up when a background refetch fails", () => {
		const refetch = vi.fn()

		renderPicker(
			query({ data: { contacts: [contact("anna", "anna@filen.io", 1n), contact("bob", "bob@filen.io", 2n)], blocked: [] }, refetch })
		)

		expect(screen.getAllByTestId("contact").map(row => row.textContent)).toEqual(["anna@filen.io", "bob@filen.io"])
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
	})

	it("shows the error with a retry when nothing is loaded", () => {
		const refetch = vi.fn()

		renderPicker(query({ data: undefined, refetch }))

		expect(screen.getByText("Network error")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(refetch).toHaveBeenCalledTimes(1)
	})
})

describe("ContactPickerList — no contacts", () => {
	it("offers adding a contact", () => {
		renderPicker(successQuery({ contacts: [], blocked: [] }))

		expect(screen.getByText("No contacts")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy()
	})
})
