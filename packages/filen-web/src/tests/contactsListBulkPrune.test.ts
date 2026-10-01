// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"
import type { Contact, ContactRequestIn } from "@filen/sdk-rs"

// A bulk contacts op deliberately prunes only what SUCCEEDED, so the failures stay selected and the user
// can retry them in one click. Drive's analogous helper is pinned (bulkActionBar.test.ts's runBulkFavorite);
// contacts' two call sites — the accept path and the shared confirm-dialog tail — are not, and pruning the
// whole selection instead would silently drop the very rows that need another attempt. Both run as
// activity toasts, whose words are checked too.

const { acceptRequest, removeContact, useContactsListSelection, pruneSelection, toast } = vi.hoisted(() => ({
	acceptRequest: vi.fn(),
	removeContact: vi.fn(),
	useContactsListSelection: vi.fn(),
	pruneSelection: vi.fn(),
	toast: Object.assign(
		vi.fn<(title: string, options?: ExternalToast) => string>(() => "id"),
		{
			success: vi.fn<(title: string, options?: ExternalToast) => string>(),
			error: vi.fn<(title: string, options?: ExternalToast) => string>(),
			warning: vi.fn(),
			dismiss: vi.fn()
		}
	)
}))
const toastSuccess = toast.success
const toastError = toast.error

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
// useDialogHost closes on navigation, so it reads the current href off the router.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouterState: () => "/contacts" }))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

// The selection hook has its own test file; here it is a stand-in so a multi-row selection can be set up
// without driving clicks, and so the prune the component performs is directly observable.
vi.mock("@/features/contacts/hooks/useContactsListSelection", () => ({ useContactsListSelection }))

// Only the two singular ops are stubbed — runBulkOutcomes stays real, since "which uuids succeeded" is
// exactly what this asserts on.
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
		expect(toast.mock.calls[0]?.[0]).toBe("Accepting 2 requests")
		expect(toastError).toHaveBeenCalledExactlyOnceWith("Accepted 1 request, 1 failed", expect.anything())
	})

	it("accepts one request from its row as an activity naming it, holding its button meanwhile", async () => {
		const { promise, resolve } = Promise.withResolvers<{ status: "success" }>()
		acceptRequest.mockReturnValue(promise)
		useContactsListSelection.mockReturnValue(selectionStub({}))

		render(createElement(ContactsList, { section: "requests" as const }))

		const [accept] = screen.getAllByRole("button", { name: "Accept" })

		if (accept === undefined) {
			throw new Error("no accept button")
		}

		fireEvent.click(accept)
		fireEvent.click(accept)

		expect(toast).toHaveBeenCalledExactlyOnceWith("Accepting the request from ra@example.com", expect.anything())
		expect(acceptRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_A.uuid)
		await waitFor(() => {
			expect(accept.hasAttribute("disabled")).toBe(true)
		})

		resolve({ status: "success" })

		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith("Accepted the request from ra@example.com", expect.anything())
		})
		expect(pruneSelection).toHaveBeenCalledWith("requests", [REQUEST_A.uuid])
		await waitFor(() => {
			expect(accept.hasAttribute("disabled")).toBe(false)
		})
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
		expect(toast.mock.calls[0]?.[0]).toBe("Removing 2 contacts")
		expect(toastError).toHaveBeenCalledExactlyOnceWith("Removed 1 contact, 1 failed", expect.anything())
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
		expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't remove 2 contacts", expect.anything())
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
		expect(toastSuccess).toHaveBeenCalledExactlyOnceWith("Removed 2 contacts", expect.anything())
	})
})
