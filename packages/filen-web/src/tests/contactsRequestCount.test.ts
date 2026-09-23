// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut, UuidStr } from "@filen/sdk-rs"

const {
	getContacts,
	getBlockedContacts,
	listIncomingContactRequests,
	listOutgoingContactRequests,
	acceptContactRequest,
	unblockContact,
	deleteContact,
	sendContactRequest,
	cancelContactRequest
} = vi.hoisted(() => ({
	getContacts: vi.fn<() => Promise<Contact[]>>(),
	getBlockedContacts: vi.fn<() => Promise<BlockedContact[]>>(),
	listIncomingContactRequests: vi.fn<() => Promise<ContactRequestIn[]>>(),
	listOutgoingContactRequests: vi.fn<() => Promise<ContactRequestOut[]>>(),
	acceptContactRequest: vi.fn<(uuid: string) => Promise<string>>(),
	unblockContact: vi.fn<(uuid: string) => Promise<void>>(),
	deleteContact: vi.fn<(uuid: string) => Promise<void>>(),
	sendContactRequest: vi.fn<(email: string) => Promise<string>>(),
	cancelContactRequest: vi.fn<(uuid: string) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		getContacts,
		getBlockedContacts,
		listIncomingContactRequests,
		listOutgoingContactRequests,
		acceptContactRequest,
		unblockContact,
		deleteContact,
		sendContactRequest,
		cancelContactRequest
	}
}))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import {
	CONTACTS_QUERY_KEY,
	CONTACTS_STALE_TIME,
	CONTACT_REQUESTS_QUERY_KEY,
	contactsQueryUpdate,
	useContactRequestsQuery,
	useContactsQuery,
	type ContactsQueryData
} from "@/features/contacts/queries/contacts"
import {
	acceptRequest,
	cancelRequest,
	removeContact,
	runContactsBulk,
	sendContactRequest as sendContactRequestAction,
	unblockContact as unblockContactAction
} from "@/features/contacts/lib/actions"
import { handleContactEvent } from "@/features/contacts/lib/socketHandlers"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockContact(label: string): Contact {
	return {
		uuid: testUuid(label),
		userId: 1n,
		email: `${label}@filen.io`,
		nickName: label,
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "key"
	}
}

function mockBlocked(label: string): BlockedContact {
	return { uuid: testUuid(`${label}-blk`), userId: 2n, email: `${label}@filen.io`, nickName: label, timestamp: 0n }
}

function mockOutgoing(label: string): ContactRequestOut {
	return { uuid: testUuid(`${label}-out`), email: `${label}@filen.io`, nickName: label }
}

function mockIncoming(label: string): ContactRequestIn {
	return { uuid: testUuid(`${label}-in`), userId: 3n, email: `${label}@filen.io`, nickName: label }
}

// Server-side state the list ops snapshot, so an accept's read-back sees what the accept changed.
let serverContacts: Contact[] = []
let serverIncoming: ContactRequestIn[] = []
let serverBlocked: BlockedContact[] = []
let serverOutgoing: ContactRequestOut[] = []

// Holds the next read of `op` open until the returned release is called; it answers with the server
// state as of the call, like a real read snapshotted before later writes.
function holdNextRead<T>(op: { mockImplementationOnce: (impl: () => Promise<T>) => unknown }, snapshot: () => T): () => void {
	let release!: () => void
	op.mockImplementationOnce(() => {
		const value = snapshot()

		return new Promise<T>(resolve => {
			release = () => {
				resolve(value)
			}
		})
	})

	return () => {
		release()
	}
}

function cachedContacts(): ContactsQueryData | undefined {
	return queryClient.getQueryData<ContactsQueryData>(CONTACTS_QUERY_KEY)
}

function cachedOutgoing(): ContactRequestOut[] | undefined {
	return queryClient.getQueryData<{ outgoing: ContactRequestOut[] }>(CONTACT_REQUESTS_QUERY_KEY)?.outgoing
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

// The shell's always-mounted rail badge.
function mountIconRail() {
	return renderHook(() => useContactRequestsQuery(), { wrapper })
}

// The /contacts page's own pair.
function mountContactsPage() {
	return renderHook(
		() => {
			useContactsQuery()

			return useContactRequestsQuery()
		},
		{ wrapper }
	)
}

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

function counts() {
	return {
		contacts: getContacts.mock.calls.length,
		blocked: getBlockedContacts.mock.calls.length,
		incoming: listIncomingContactRequests.mock.calls.length,
		outgoing: listOutgoingContactRequests.mock.calls.length
	}
}

function focus(): void {
	act(() => {
		focusManager.setFocused(false)
		focusManager.setFocused(true)
	})
}

function pastWindow(): void {
	const now = Date.now()
	vi.spyOn(Date, "now").mockReturnValue(now + CONTACTS_STALE_TIME + 1)
}

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()
	serverContacts = [mockContact("alice")]
	serverIncoming = [mockIncoming("carol"), mockIncoming("erin"), mockIncoming("frank")]
	getContacts.mockImplementation(() => Promise.resolve([...serverContacts]))
	serverBlocked = [mockBlocked("gina"), mockBlocked("hank"), mockBlocked("ivan")]
	serverOutgoing = [mockOutgoing("judy")]
	getBlockedContacts.mockImplementation(() => Promise.resolve([...serverBlocked]))
	listIncomingContactRequests.mockImplementation(() => Promise.resolve([...serverIncoming]))
	listOutgoingContactRequests.mockImplementation(() => Promise.resolve([...serverOutgoing]))
	unblockContact.mockImplementation(uuid => {
		const blocked = serverBlocked.find(b => b.uuid === uuid)

		serverBlocked = serverBlocked.filter(b => b.uuid !== uuid)

		if (blocked !== undefined) {
			serverContacts = [...serverContacts, mockContact(blocked.nickName)]
		}

		return Promise.resolve()
	})
	deleteContact.mockImplementation(uuid => {
		serverContacts = serverContacts.filter(c => c.uuid !== uuid)

		return Promise.resolve()
	})
	sendContactRequest.mockImplementation(email => {
		serverOutgoing = [...serverOutgoing, mockOutgoing(email.split("@")[0] ?? email)]

		return Promise.resolve(testUuid("sent"))
	})
	cancelContactRequest.mockImplementation(uuid => {
		serverOutgoing = serverOutgoing.filter(r => r.uuid !== uuid)

		return Promise.resolve()
	})
	acceptContactRequest.mockImplementation(uuid => {
		const request = serverIncoming.find(r => r.uuid === uuid)

		serverIncoming = serverIncoming.filter(r => r.uuid !== uuid)

		if (request !== undefined) {
			serverContacts = [...serverContacts, mockContact(request.nickName)]
		}

		return Promise.resolve(testUuid("promoted"))
	})
	// A new socket session per test, so no earlier test's read counts.
	socketAuthenticated()
})

afterEach(() => {
	vi.restoreAllMocks()
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("contacts request counts", () => {
	it("opening /contacts after boot reuses the requests the rail already read", async () => {
		mountIconRail()
		await drain()

		expect(counts()).toEqual({ contacts: 0, blocked: 0, incoming: 1, outgoing: 1 })

		mountContactsPage().unmount()
		await drain()
		mountContactsPage()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 1, outgoing: 1 })
	})

	it("a requests read the socket wasn't up for doesn't count", async () => {
		socketDropped()
		mountIconRail()
		await drain()

		socketAuthenticated()
		mountContactsPage()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 2, outgoing: 2 })

		mountContactsPage()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 2, outgoing: 2 })
	})

	it("focus inside the window reads nothing; past it both read again", async () => {
		mountIconRail()
		mountContactsPage()
		await drain()
		focus()
		focus()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 1, outgoing: 1 })

		pastWindow()
		focus()
		await drain()

		expect(counts()).toEqual({ contacts: 2, blocked: 2, incoming: 2, outgoing: 2 })
	})

	it("a socket drop ends the requests window; the contacts window is unaffected", async () => {
		mountIconRail()
		mountContactsPage()
		await drain()

		socketDropped()
		focus()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 2, outgoing: 2 })

		// Read while the socket was down: the focus after re-auth reads again, then the window holds.
		socketAuthenticated()
		focus()
		await drain()
		focus()
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 3, outgoing: 3 })
	})

	it("a network reconnect reads both again inside the window", async () => {
		mountIconRail()
		mountContactsPage()
		await drain()

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await drain()

		expect(counts()).toEqual({ contacts: 2, blocked: 2, incoming: 2, outgoing: 2 })
	})

	it("a received request lands without a read and doesn't end the window", async () => {
		mountIconRail()
		await drain()

		const dave = mockIncoming("dave")
		handleContactEvent({
			type: "contact",
			contactMessageId: 1n,
			inner: {
				type: "contactRequestReceived",
				uuid: dave.uuid,
				senderId: 3,
				senderEmail: dave.email,
				senderAvatar: undefined,
				senderNickName: dave.nickName,
				sentTimestamp: 0n
			}
		})
		mountContactsPage()
		await drain()

		expect(counts().incoming).toBe(1)
		expect(queryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming.map(r => r.uuid)).toContain(
			dave.uuid
		)
	})

	it("accepting a request reads back only the contact list", async () => {
		mountIconRail()
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		expect(await acceptRequest(mockIncoming("carol").uuid)).toEqual({ status: "success" })
		await waitFor(() => {
			expect(queryClient.getQueryData<ContactsQueryData>(CONTACTS_QUERY_KEY)?.contacts.map(c => c.nickName)).toEqual([
				"alice",
				"carol"
			])
		})
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 0, incoming: 0, outgoing: 0 })
		expect(queryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toHaveLength(2)
	})

	it("a bulk accept reads the contact list at most twice and ends with every accepted contact", async () => {
		mountIconRail()
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		const outcome = await runContactsBulk(serverIncoming, request => acceptRequest(request.uuid))

		expect(outcome.failed).toEqual([])
		await waitFor(() => {
			expect(queryClient.getQueryData<ContactsQueryData>(CONTACTS_QUERY_KEY)?.contacts).toHaveLength(4)
		})
		await drain()

		expect(counts()).toEqual({ contacts: 2, blocked: 0, incoming: 0, outgoing: 0 })
		expect(queryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([])
	})

	it("an accept during a read-back gets a read that starts after it", async () => {
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		const releaseFirst = holdNextRead(getContacts, () => [...serverContacts])

		await acceptRequest(mockIncoming("carol").uuid)
		await acceptRequest(mockIncoming("erin").uuid)
		releaseFirst()
		await waitFor(() => {
			expect(getContacts).toHaveBeenCalledTimes(2)
		})
		await drain()

		expect(cachedContacts()?.contacts.map(c => c.nickName)).toEqual(["alice", "carol", "erin"])
	})

	it("an unblock during a read-back waits for a read that starts after it", async () => {
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		const releaseFirst = holdNextRead(getContacts, () => [...serverContacts])
		const first = unblockContactAction(mockBlocked("gina").uuid)
		await waitFor(() => {
			expect(getContacts).toHaveBeenCalledOnce()
		})
		const second = unblockContactAction(mockBlocked("hank").uuid)
		await waitFor(() => {
			expect(unblockContact).toHaveBeenCalledTimes(2)
		})
		releaseFirst()

		expect(await first).toEqual({ status: "success" })
		expect(await second).toEqual({ status: "success" })
		await drain()

		expect(counts()).toEqual({ contacts: 2, blocked: 0, incoming: 0, outgoing: 0 })
		expect(cachedContacts()?.contacts.map(c => c.nickName)).toEqual(["alice", "gina", "hank"])
		expect(cachedContacts()?.blocked.map(c => c.nickName)).toEqual(["ivan"])
	})

	it("a bulk unblock reads the contact list at most twice and ends with every unblocked contact", async () => {
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		const outcome = await runContactsBulk([...serverBlocked], blocked => unblockContactAction(blocked.uuid))
		await drain()

		expect(outcome.failed).toEqual([])
		expect(counts()).toEqual({ contacts: 2, blocked: 0, incoming: 0, outgoing: 0 })
		expect(cachedContacts()).toEqual({
			contacts: [mockContact("alice"), mockContact("gina"), mockContact("hank"), mockContact("ivan")],
			blocked: []
		})
	})

	it("a removal landing during a read-back reads once more, so the removed contact stays gone", async () => {
		mountContactsPage()
		await drain()
		vi.clearAllMocks()

		const releaseFirst = holdNextRead(getContacts, () => [...serverContacts])
		await acceptRequest(mockIncoming("carol").uuid)
		await removeContact(mockContact("alice").uuid)
		releaseFirst()
		await waitFor(() => {
			expect(getContacts).toHaveBeenCalledTimes(2)
		})
		await drain()

		expect(cachedContacts()?.contacts.map(c => c.nickName)).toEqual(["carol"])
	})

	it("a cancel landing during a send's read-back reads once more, so the cancelled request stays gone", async () => {
		mountIconRail()
		await drain()
		vi.clearAllMocks()

		const releaseFirst = holdNextRead(listOutgoingContactRequests, () => [...serverOutgoing])
		const sent = sendContactRequestAction("kate@filen.io")
		await waitFor(() => {
			expect(listOutgoingContactRequests).toHaveBeenCalledOnce()
		})
		expect(await cancelRequest(mockOutgoing("judy").uuid)).toEqual({ status: "success" })
		releaseFirst()

		expect(await sent).toEqual({ status: "success" })
		await drain()

		expect(counts()).toEqual({ contacts: 0, blocked: 0, incoming: 0, outgoing: 2 })
		expect(cachedOutgoing()?.map(r => r.nickName)).toEqual(["kate"])
	})

	it("a patch keeps a pending refresh pending", async () => {
		mountContactsPage()
		await drain()

		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY, refetchType: "none" })
		})
		contactsQueryUpdate(prev => ({ ...prev, contacts: [] }))

		expect(queryClient.getQueryCache().find({ queryKey: CONTACTS_QUERY_KEY, exact: true })?.state.isInvalidated).toBe(true)

		focus()
		await drain()

		expect(counts().contacts).toBe(2)
	})

	it("reopening the share dialog's contact picker reuses the contact list", async () => {
		for (let i = 0; i < 3; i++) {
			const view = render(createElement(ContactPickerDialog, { items: [], onClose: () => undefined }), { wrapper })

			await screen.findByText("alice")
			view.unmount()
		}
		await drain()

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 0, outgoing: 0 })
	})
})

// Read-this-session is module state, so this runs against a fresh copy of the contacts module.
describe("contacts first read of the session", () => {
	it("restored caches are read on their first mount, then reused", async () => {
		vi.resetModules()
		const fresh = await import("@/features/contacts/queries/contacts")
		const session = await import("@/lib/sdk/socketSession")
		const { queryClient: freshClient } = await import("@/queries/client")
		freshClient.clear()
		session.socketAuthenticated()
		freshClient.setQueryData(fresh.CONTACTS_QUERY_KEY, { contacts: [], blocked: [] }, { updatedAt: Date.now() })
		freshClient.setQueryData(fresh.CONTACT_REQUESTS_QUERY_KEY, { incoming: [], outgoing: [] }, { updatedAt: Date.now() })

		const freshWrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: freshClient, children })
		const mountBoth = () =>
			renderHook(
				() => {
					fresh.useContactsQuery()

					return fresh.useContactRequestsQuery()
				},
				{ wrapper: freshWrapper }
			)

		mountBoth().unmount()
		await waitFor(() => {
			expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 1, outgoing: 1 })
		})
		await waitFor(() => {
			expect(freshClient.isFetching()).toBe(0)
		})

		mountBoth()
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(counts()).toEqual({ contacts: 1, blocked: 1, incoming: 1, outgoing: 1 })
	})
})
