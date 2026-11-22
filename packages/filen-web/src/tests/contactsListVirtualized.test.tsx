// @vitest-environment jsdom

// An account with hundreds of contacts mounts a window of them; every section stays its own listbox with its one Tab
// stop, and the arrow keys walk the cursor to rows outside the window.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Contact, ContactRequestIn } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouterState: () => "/contacts" }))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), OUTSIDE_OVERLAYS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const { data } = vi.hoisted(() => {
	const contacts = Array.from({ length: 500 }, (_, index) => ({
		uuid: `contact-${String(index).padStart(3, "0")}`,
		userId: BigInt(index + 1),
		email: `user${String(index).padStart(3, "0")}@example.com`,
		nickName: "",
		avatar: undefined,
		lastActive: 0n,
		timestamp: 0n
	}))
	const incoming = Array.from({ length: 3 }, (_, index) => ({
		uuid: `request-${String(index)}`,
		userId: BigInt(1000 + index),
		email: `request${String(index)}@example.com`,
		nickName: "",
		avatar: undefined,
		timestamp: 0n
	}))

	return { data: { contacts, incoming } }
})

vi.mock("@/features/contacts/queries/contacts", () => ({
	useContactsQuery: () => ({ status: "success", data: { contacts: data.contacts as unknown as Contact[], blocked: [] } }),
	useContactRequestsQuery: () => ({ status: "success", data: { incoming: data.incoming as unknown as ContactRequestIn[], outgoing: [] } })
}))

import "@/lib/i18n"
import { stubElementSize } from "@/tests/stubElementSize"
import { ContactsList } from "@/features/contacts/components/contactsList"

let restoreSize: () => void = () => undefined

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 600, clientWidth: 600 })
})

afterAll(() => {
	restoreSize()
})

afterEach(cleanup)

function contactsListbox(): HTMLElement {
	const listbox = screen.getAllByRole("listbox").find(element =>
		within(element)
			.queryAllByRole("option")
			.some(option => option.textContent.includes("user"))
	)

	if (listbox === undefined) {
		throw new Error("no contacts listbox")
	}

	return listbox
}

describe("ContactsList with many contacts", () => {
	it("mounts a window of the rows, keeping a listbox per section", () => {
		render(createElement(ContactsList, { section: "all" }))

		expect(screen.getAllByRole("listbox")).toHaveLength(2)
		expect(screen.getAllByRole("option").length).toBeLessThan(40)
		expect(within(contactsListbox()).getAllByRole("option")[0]?.getAttribute("aria-setsize")).toBe("500")
	})

	it("walks the cursor with the arrow keys to the last contact, outside the first window", async () => {
		render(createElement(ContactsList, { section: "contacts" }))

		const first = within(contactsListbox()).getAllByRole("option")[0]

		if (first === undefined) {
			throw new Error("no first row")
		}

		expect(first.tabIndex).toBe(0)

		first.focus()
		fireEvent.keyDown(first, { key: "End" })

		// The reveal scrolls the list; jsdom reports the scroll through a scroll event.
		const scroller = contactsListbox().closest("section")?.parentElement?.parentElement

		if (scroller === null || scroller === undefined) {
			throw new Error("no scroller")
		}

		await act(async () => {
			scroller.dispatchEvent(new Event("scroll"))
			await new Promise(resolve => requestAnimationFrame(resolve))
			await new Promise(resolve => requestAnimationFrame(resolve))
		})

		const focused = document.activeElement

		expect(focused?.getAttribute("role")).toBe("option")
		expect(focused?.getAttribute("aria-posinset")).toBe("500")
		expect(focused?.textContent).toContain("user499@example.com")
		expect(focused?.getAttribute("tabindex")).toBe("0")
	})

	it("selects a row by click and toggles it with Space", () => {
		render(createElement(ContactsList, { section: "contacts" }))

		const [first, second] = within(contactsListbox()).getAllByRole("option")

		if (first === undefined || second === undefined) {
			throw new Error("no rows")
		}

		fireEvent.click(second)

		expect(second.getAttribute("aria-selected")).toBe("true")

		fireEvent.keyDown(second, { key: " " })

		expect(second.getAttribute("aria-selected")).toBe("false")
	})
})
