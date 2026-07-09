import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

// Same mock boundary as drive.test.ts/account.test.ts: the real sdk client module imports a Vite
// `?worker`, unresolvable under node vitest — mock it down to the four ops this module calls.
const { getContacts, getBlockedContacts, listIncomingContactRequests, listOutgoingContactRequests } = vi.hoisted(() => ({
	getContacts: vi.fn<() => Promise<Contact[]>>(),
	getBlockedContacts: vi.fn<() => Promise<BlockedContact[]>>(),
	listIncomingContactRequests: vi.fn<() => Promise<ContactRequestIn[]>>(),
	listOutgoingContactRequests: vi.fn<() => Promise<ContactRequestOut[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { getContacts, getBlockedContacts, listIncomingContactRequests, listOutgoingContactRequests }
}))

// Every other hook wrapper below is a one-line pass-through no node-environment test can render (no
// DOM — see vitest.config.ts). useContactsQuery's `enabled` default is worth covering directly
// anyway, same rationale as drive.test.ts's useItemInfoQuery coverage: get the fallback wrong (e.g.
// defaulting to false) and contactsList.tsx's own bare call silently stops fetching. This only
// intercepts useQuery itself — real `useQuery` internals are never exercised, just whether our
// wrapper forwards `enabled` into its options — so QueryClient (used below to build testQueryClient)
// and the rest of the module stay real.
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock("@tanstack/react-query", async importOriginal => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>()
	return { ...actual, useQuery }
})

// A bare, unconfigured QueryClient stands in for the real singleton — same rationale as
// drive.test.ts: the patchers only need genuine setQueryData/getQueryData cache mechanics, never
// the production client's OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import {
	CONTACTS_QUERY_KEY,
	CONTACT_REQUESTS_QUERY_KEY,
	contactRequestsQueryUpdate,
	contactsQueryGet,
	contactsQueryUpdate,
	fetchContactRequests,
	fetchContacts,
	useContactsQuery
} from "@/features/contacts/queries/contacts"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		userId: 1n,
		email: "alice@filen.io",
		nickName: "Alice",
		lastActive: 1_700_000_000_000n,
		timestamp: 1_700_000_000_000n,
		publicKey: "alice-public-key",
		...overrides
	}
}

function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: "22222222-2222-2222-2222-222222222222",
		userId: 2n,
		email: "bob@filen.io",
		nickName: "Bob",
		timestamp: 1_700_000_000_000n,
		...overrides
	}
}

function mockIncoming(overrides: Partial<ContactRequestIn> = {}): ContactRequestIn {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		userId: 3n,
		email: "carol@filen.io",
		nickName: "Carol",
		...overrides
	}
}

function mockOutgoing(overrides: Partial<ContactRequestOut> = {}): ContactRequestOut {
	return {
		uuid: "44444444-4444-4444-4444-444444444444",
		email: "dave@filen.io",
		nickName: "Dave",
		...overrides
	}
}

describe("CONTACTS_QUERY_KEY", () => {
	it("is the bare domain tuple, no per-entity param (no bigint)", () => {
		expect(CONTACTS_QUERY_KEY).toEqual(["contacts"])
	})
})

describe("CONTACT_REQUESTS_QUERY_KEY", () => {
	it("is the bare domain tuple, no per-entity param (no bigint)", () => {
		expect(CONTACT_REQUESTS_QUERY_KEY).toEqual(["contactRequests"])
	})
})

describe("fetchContacts", () => {
	it("parallel-fetches getContacts and getBlockedContacts and merges the result", async () => {
		const contact = mockContact()
		const blocked = mockBlockedContact()
		getContacts.mockResolvedValueOnce([contact])
		getBlockedContacts.mockResolvedValueOnce([blocked])

		await expect(fetchContacts()).resolves.toEqual({ contacts: [contact], blocked: [blocked] })
		expect(getContacts).toHaveBeenCalledTimes(1)
		expect(getBlockedContacts).toHaveBeenCalledTimes(1)
	})

	it("propagates a rejection from getContacts unchanged", async () => {
		const error = new Error("no authenticated client")
		getContacts.mockRejectedValueOnce(error)
		getBlockedContacts.mockResolvedValueOnce([])

		await expect(fetchContacts()).rejects.toBe(error)
	})

	it("propagates a rejection from getBlockedContacts unchanged", async () => {
		const error = new Error("no authenticated client")
		getContacts.mockResolvedValueOnce([])
		getBlockedContacts.mockRejectedValueOnce(error)

		await expect(fetchContacts()).rejects.toBe(error)
	})
})

describe("useContactsQuery", () => {
	// contactsList.tsx's own call passes no options at all — a wrong default here would silently
	// stop it from ever fetching.
	it("defaults enabled to true when no options are given", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useContactsQuery()

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true }))
	})

	// useBlockedUsers.ts disables this query on every drive variant except sharedIn (the only one
	// that filters by the blocked set) — `enabled` reaching useQuery unchanged is the one thing this
	// thin wrapper must get right, same rationale as drive.test.ts's useItemInfoQuery coverage.
	it("forwards enabled: false through to useQuery, unmodified", () => {
		useQuery.mockReturnValue({ status: "pending" })

		useContactsQuery({ enabled: false })

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})
})

describe("fetchContactRequests", () => {
	it("parallel-fetches listIncoming/listOutgoing and merges the result", async () => {
		const incoming = mockIncoming()
		const outgoing = mockOutgoing()
		listIncomingContactRequests.mockResolvedValueOnce([incoming])
		listOutgoingContactRequests.mockResolvedValueOnce([outgoing])

		await expect(fetchContactRequests()).resolves.toEqual({ incoming: [incoming], outgoing: [outgoing] })
		expect(listIncomingContactRequests).toHaveBeenCalledTimes(1)
		expect(listOutgoingContactRequests).toHaveBeenCalledTimes(1)
	})

	it("propagates a rejection from listIncomingContactRequests unchanged", async () => {
		const error = new Error("no authenticated client")
		listIncomingContactRequests.mockRejectedValueOnce(error)
		listOutgoingContactRequests.mockResolvedValueOnce([])

		await expect(fetchContactRequests()).rejects.toBe(error)
	})

	it("propagates a rejection from listOutgoingContactRequests unchanged", async () => {
		const error = new Error("no authenticated client")
		listIncomingContactRequests.mockResolvedValueOnce([])
		listOutgoingContactRequests.mockRejectedValueOnce(error)

		await expect(fetchContactRequests()).rejects.toBe(error)
	})
})

describe("contactsQueryUpdate", () => {
	it("defaults an uncached query to empty arrays before applying the updater", () => {
		const contact = mockContact()

		contactsQueryUpdate(prev => ({ ...prev, contacts: [...prev.contacts, contact] }))

		expect(testQueryClient.getQueryData(CONTACTS_QUERY_KEY)).toEqual({ contacts: [contact], blocked: [] })
	})

	it("passes the previously cached data through to the updater unchanged", () => {
		const contact = mockContact()
		const blocked = mockBlockedContact()
		testQueryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: [contact], blocked: [blocked] })

		let seenPrev: unknown
		contactsQueryUpdate(prev => {
			seenPrev = prev
			return prev
		})

		expect(seenPrev).toEqual({ contacts: [contact], blocked: [blocked] })
	})

	it("never touches the contactRequests key", () => {
		testQueryClient.setQueryData(CONTACT_REQUESTS_QUERY_KEY, { incoming: [], outgoing: [] })

		contactsQueryUpdate(prev => ({ ...prev, contacts: [mockContact()] }))

		expect(testQueryClient.getQueryData(CONTACT_REQUESTS_QUERY_KEY)).toEqual({ incoming: [], outgoing: [] })
	})
})

describe("contactsQueryGet", () => {
	it("returns undefined for an uncached query", () => {
		expect(contactsQueryGet()).toBeUndefined()
	})

	it("returns the currently cached data", () => {
		const contact = mockContact()
		testQueryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: [contact], blocked: [] })

		expect(contactsQueryGet()).toEqual({ contacts: [contact], blocked: [] })
	})
})

describe("contactRequestsQueryUpdate", () => {
	it("defaults an uncached query to empty arrays before applying the updater", () => {
		const incoming = mockIncoming()

		contactRequestsQueryUpdate(prev => ({ ...prev, incoming: [...prev.incoming, incoming] }))

		expect(testQueryClient.getQueryData(CONTACT_REQUESTS_QUERY_KEY)).toEqual({ incoming: [incoming], outgoing: [] })
	})

	it("passes the previously cached data through to the updater unchanged", () => {
		const incoming = mockIncoming()
		const outgoing = mockOutgoing()
		testQueryClient.setQueryData(CONTACT_REQUESTS_QUERY_KEY, { incoming: [incoming], outgoing: [outgoing] })

		let seenPrev: unknown
		contactRequestsQueryUpdate(prev => {
			seenPrev = prev
			return prev
		})

		expect(seenPrev).toEqual({ incoming: [incoming], outgoing: [outgoing] })
	})

	it("never touches the contacts key", () => {
		testQueryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: [], blocked: [] })

		contactRequestsQueryUpdate(prev => ({ ...prev, incoming: [mockIncoming()] }))

		expect(testQueryClient.getQueryData(CONTACTS_QUERY_KEY)).toEqual({ contacts: [], blocked: [] })
	})
})
