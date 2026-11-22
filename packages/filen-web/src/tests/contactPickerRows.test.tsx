// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Contact } from "@filen/sdk-rs"
import "@/lib/i18n"
import { ContactPickerRows } from "@/features/contacts/components/contactPickerRows"
import { testUuid } from "@/tests/support/uuid"
import { stubElementSize } from "@/tests/stubElementSize"

const COUNT = 500
const contacts: Contact[] = Array.from({ length: COUNT }, (_, index) => ({
	uuid: testUuid(`contact-${String(index)}`),
	userId: BigInt(index + 1),
	email: `user${String(index)}@filen.io`,
	nickName: undefined,
	lastActive: 0n,
	timestamp: 0n,
	publicKey: "key"
}))

let restoreSize: () => void = () => undefined

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 400, clientWidth: 400 })
})

afterAll(() => {
	restoreSize()
})

afterEach(cleanup)

function renderRows(onToggle = vi.fn(), selected: ReadonlySet<string> = new Set()) {
	render(createElement(ContactPickerRows, { contacts, selected, onToggle, ariaLabel: "Contacts" }))

	return onToggle
}

describe("ContactPickerRows", () => {
	it("mounts a window of the contacts, each placed among all of them", () => {
		renderRows()

		const options = screen.getAllByRole("option")

		expect(options.length).toBeGreaterThan(0)
		expect(options.length).toBeLessThan(30)
		expect(options[0]?.getAttribute("aria-posinset")).toBe("1")
		expect(options[0]?.getAttribute("aria-setsize")).toBe(String(COUNT))
	})

	it("reaches the last contact by scrolling, and toggles it from the keyboard", () => {
		const onToggle = renderRows()
		const listbox = screen.getByRole("listbox", { name: "Contacts" })

		act(() => {
			listbox.scrollTop = COUNT * 58
			listbox.dispatchEvent(new Event("scroll"))
		})

		const last = screen.getAllByRole("option").find(option => option.getAttribute("aria-posinset") === String(COUNT))

		expect(last?.textContent).toContain(`user${String(COUNT - 1)}@filen.io`)

		if (last === undefined) {
			throw new Error("last row not mounted")
		}

		fireEvent.keyDown(last, { key: "Enter" })

		expect(onToggle).toHaveBeenCalledWith(contacts[COUNT - 1]?.uuid)
	})

	it("shows the selection and toggles a row on click", () => {
		const first = contacts[0]

		if (first === undefined) {
			throw new Error("no contacts")
		}

		const onToggle = renderRows(vi.fn(), new Set([first.uuid]))
		const options = screen.getAllByRole("option")

		expect(options[0]?.getAttribute("aria-selected")).toBe("true")
		expect(options[1]?.getAttribute("aria-selected")).toBe("false")

		if (options[1] === undefined) {
			throw new Error("second row not mounted")
		}

		fireEvent.click(options[1])

		expect(onToggle).toHaveBeenCalledWith(contacts[1]?.uuid)
	})
})
