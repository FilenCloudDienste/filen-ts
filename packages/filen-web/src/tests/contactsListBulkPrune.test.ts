// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Contact, ContactRequestIn } from "@filen/sdk-rs"

// A bulk contacts op deliberately prunes only what SUCCEEDED, so the failures stay selected and the user
// can retry them in one click. Drive's analogous helper is pinned (bulkActionBar.test.ts's runBulkFavorite);
// contacts' two call sites — the accept path and the shared confirm-dialog tail — are not, and pruning the
// whole selection instead would silently drop the very rows that need another attempt.

const { acceptRequest, removeContact, useContactsListSelection, pruneSelection, toastSuccess, toastError } = vi.hoisted(() => ({
	acceptRequest: vi.fn(),
	removeContact: vi.fn(),
	useContactsListSelection: vi.fn(),
	pruneSelection: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, warning: vi.fn() } }))
// useDialogHost closes on navigation, so it reads the current href off the router.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouterState: () => "/contacts" }))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

// The selection hook has its own test file; here it is a stand-in so a multi-row selection can be set up
// without driving clicks, and so the prune the component performs is directly observable.
vi.mock("@/features/contacts/hooks/useContactsListSelection", () => ({ useContactsListSelection }))

// Only the two singular ops are stubbed — runContactsBulk (and the per-item runBulk contract it adapts)
// stays real, since "which uuids succeeded" is exactly what this asserts on.
vi.mock("@/features/contacts/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/contacts/lib/actions")>()),
	acceptRequest,
	removeContact
}))

const { queryData } = vi.hoisted(() => ({
	queryData: { current: { contacts: [] as unknown[], blocked: [] as unknown[], incoming: [] as unknown[], outgoing: [] as unknown[] } }
}))

vi.mock("@/features/contacts/queries/contacts", () => ({
	useContactsQuery: () => ({ status: "success", data: { contacts: queryData.current.contacts, blocked: queryData.current.blocked } }),
	useContactRequestsQuery: () => ({
		status: "success",
		data: { incoming: queryData.current.incoming, outgoing: queryData.current.outgoing }
	})
}))

import "@/lib/i18n"
import { EMPTY_CONTACT_SELECTION } from "@/features/contacts/lib/selection"
import { ContactsList } from "@/features/contacts/components/contactsList"

function contact(uuid: string, email: string): Contact {
	return { uuid, userId: 1n, email, nickName: email, avatar: undefined, lastActive: 0n, timestamp: 0n } as unknown as Contact
}

function request(uuid: string, email: string): ContactRequestIn {
	return { uuid, userId: 1n, email, nickName: email, avatar: undefined, timestamp: 0n } as unknown as ContactRequestIn
}

const CONTACT_A = contact("contact-a", "a@example.com")
const CONTACT_B = contact("contact-b", "b@example.com")
const REQUEST_A = request("request-a", "ra@example.com")
const REQUEST_B = request("request-b", "rb@example.com")

function selectionStub(selected: { contacts?: string[]; requests?: string[] }) {
	return {
		selection: {
			...EMPTY_CONTACT_SELECTION,
			contacts: new Set(selected.contacts ?? []),
			requests: new Set(selected.requests ?? [])
		},
		selectedCount: (selected.contacts?.length ?? 0) + (selected.requests?.length ?? 0),
		activeIndexFor: () => 0,
		registerRowRef: vi.fn(),
		handlePointerSelect: vi.fn(),
		handleKeyDown: vi.fn(),
		clearSelection: vi.fn(),
		pruneSelection
	}
}

// One op fails, the rest succeed — the shape every partial-failure assertion below rests on.
function failingFor(uuid: string) {
	return (target: string | { uuid: string }) => {
		const targetUuid = typeof target === "string" ? target : target.uuid

		return Promise.resolve(targetUuid === uuid ? { status: "error", dto: { label: "Error", message: "nope" } } : { status: "success" })
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	queryData.current = { contacts: [CONTACT_A, CONTACT_B], blocked: [], incoming: [REQUEST_A, REQUEST_B], outgoing: [] }
})

afterEach(cleanup)

describe("ContactsList — bulk actions prune only what succeeded", () => {
	it("leaves a failed accept selected while dropping the accepted one", async () => {
		acceptRequest.mockImplementation(failingFor(REQUEST_B.uuid))
		useContactsListSelection.mockReturnValue(selectionStub({ requests: [REQUEST_A.uuid, REQUEST_B.uuid] }))

		render(createElement(ContactsList, { section: "requests" as const }))

		fireEvent.click(screen.getByRole("button", { name: /^Accept \(2\)$/ }))

		await waitFor(() => {
			expect(pruneSelection).toHaveBeenCalledTimes(1)
		})

		expect(pruneSelection).toHaveBeenCalledWith("requests", [REQUEST_A.uuid])
		expect(toastError).toHaveBeenCalledTimes(1)
	})

	it("leaves a failed remove selected while dropping the removed one, and still closes the dialog", async () => {
		removeContact.mockImplementation(failingFor(CONTACT_B.uuid))
		useContactsListSelection.mockReturnValue(selectionStub({ contacts: [CONTACT_A.uuid, CONTACT_B.uuid] }))

		render(createElement(ContactsList, { section: "contacts" as const }))

		fireEvent.click(screen.getByRole("button", { name: /^Remove \(2\)$/ }))

		const dialog = await screen.findByRole("alertdialog")

		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))

		await waitFor(() => {
			expect(pruneSelection).toHaveBeenCalledTimes(1)
		})

		expect(pruneSelection).toHaveBeenCalledWith("contacts", [CONTACT_A.uuid])
		expect(toastError).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("keeps the whole selection when every op fails, closing the dialog and warning once", async () => {
		removeContact.mockImplementation(() => Promise.resolve({ status: "error", dto: { label: "Error", message: "nope" } }))
		useContactsListSelection.mockReturnValue(selectionStub({ contacts: [CONTACT_A.uuid, CONTACT_B.uuid] }))

		render(createElement(ContactsList, { section: "contacts" as const }))

		fireEvent.click(screen.getByRole("button", { name: /^Remove \(2\)$/ }))

		const dialog = await screen.findByRole("alertdialog")

		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))

		await waitFor(() => {
			expect(pruneSelection).toHaveBeenCalledTimes(1)
		})

		expect(pruneSelection).toHaveBeenCalledWith("contacts", [])
		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("prunes every uuid when every op succeeds", async () => {
		removeContact.mockImplementation(() => Promise.resolve({ status: "success" }))
		useContactsListSelection.mockReturnValue(selectionStub({ contacts: [CONTACT_A.uuid, CONTACT_B.uuid] }))

		render(createElement(ContactsList, { section: "contacts" as const }))

		fireEvent.click(screen.getByRole("button", { name: /^Remove \(2\)$/ }))

		const dialog = await screen.findByRole("alertdialog")

		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))

		await waitFor(() => {
			expect(pruneSelection).toHaveBeenCalledTimes(1)
		})

		expect(pruneSelection).toHaveBeenCalledWith("contacts", [CONTACT_A.uuid, CONTACT_B.uuid])
		expect(toastSuccess).toHaveBeenCalledTimes(1)
	})
})
