import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const contactsQueryUpdates: Array<{ updater: (prev: unknown) => unknown }> = []
const contactRequestsQueryUpdates: Array<{ updater: (prev: unknown) => unknown }> = []

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@/features/contacts/queries/useContacts.query", () => ({
	contactsQueryUpdate: vi.fn((opts: { updater: (prev: unknown) => unknown }) => {
		contactsQueryUpdates.push(opts)
	}),
	BASE_QUERY_KEY: "useContactsQuery"
}))

vi.mock("@/features/contacts/queries/useContactRequests.query", () => ({
	contactRequestsQueryUpdate: vi.fn((opts: { updater: (prev: unknown) => unknown }) => {
		contactRequestsQueryUpdates.push(opts)
	}),
	BASE_QUERY_KEY: "useContactRequestsQuery"
}))

vi.mock("@/queries/client", () => ({
	default: {
		invalidateQueries: vi.fn().mockResolvedValue(undefined)
	}
}))

import auth from "@/lib/auth"
import contacts from "@/features/contacts/contacts"
import { contactsQueryUpdate } from "@/features/contacts/queries/useContacts.query"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/useContactRequests.query"
import queryClient from "@/queries/client"

function makeContact(overrides?: {
	uuid?: string
	userId?: bigint
	email?: string
	avatar?: string | null
	nickName?: string | null
	timestamp?: bigint
}) {
	return {
		uuid: "aaaa-1111",
		userId: 1n,
		email: "alice@example.com",
		avatar: null,
		nickName: null,
		timestamp: 1000n,
		...overrides
	}
}

function makeRequest(overrides?: { uuid?: string; email?: string }) {
	return {
		uuid: "req-1111",
		email: "requester@example.com",
		...overrides
	}
}

beforeEach(() => {
	contactsQueryUpdates.length = 0
	contactRequestsQueryUpdates.length = 0
	vi.clearAllMocks()
})

describe("contacts.block", () => {
	it("calls blockContact with the email", async () => {
		const blockContact = vi.fn().mockResolvedValue("record-uuid-alice")

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { blockContact }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const alice = makeContact({ email: "alice@example.com", uuid: "uuid-alice", userId: 42n })

		await contacts.block({
			userId: alice.userId,
			email: alice.email,
			avatar: alice.avatar ?? undefined,
			nickName: alice.nickName ?? undefined,
			timestamp: alice.timestamp
		})

		expect(blockContact).toHaveBeenCalledWith("alice@example.com", undefined)
	})

	it("moves the contact from contacts to blocked using the block-record uuid returned by blockContact", async () => {
		const alice = makeContact({ email: "alice@example.com", uuid: "uuid-alice", userId: 42n, nickName: "Al" })

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				blockContact: vi.fn().mockResolvedValue("record-uuid-alice")
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({
			userId: alice.userId,
			email: alice.email,
			avatar: alice.avatar ?? undefined,
			nickName: alice.nickName ?? undefined,
			timestamp: alice.timestamp
		})

		expect(contactsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [alice], blocked: [] as (typeof alice)[] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.contacts).toHaveLength(0)
		expect(next.blocked).toHaveLength(1)
		// uuid must be the block-record uuid returned by blockContact, NOT the contact uuid
		expect(next.blocked[0]!.uuid).toBe("record-uuid-alice")
		expect(next.blocked[0]!.userId).toBe(42n)
		expect(next.blocked[0]!.nickName).toBe("Al")
	})

	it("uses empty string for nickName when the contact has no nickName", async () => {
		const bob = makeContact({ email: "bob@example.com", uuid: "uuid-bob", nickName: null })

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				blockContact: vi.fn().mockResolvedValue("record-uuid-bob")
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({
			userId: bob.userId,
			email: bob.email,
			avatar: bob.avatar ?? undefined,
			nickName: bob.nickName ?? undefined,
			timestamp: bob.timestamp
		})

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [bob], blocked: [] as (typeof bob)[] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.blocked[0]!.nickName).toBe("")
	})

	it("deduplicates an already-blocked entry identified by email before inserting the new one", async () => {
		const carol = makeContact({ email: "carol@example.com", uuid: "uuid-carol-contact" })
		const existingBlocked = { ...carol, uuid: "uuid-carol-old-record", nickName: "" }

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				blockContact: vi.fn().mockResolvedValue("uuid-carol-new-record")
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({
			userId: carol.userId,
			email: carol.email,
			avatar: carol.avatar ?? undefined,
			nickName: carol.nickName ?? undefined,
			timestamp: carol.timestamp
		})

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [carol], blocked: [existingBlocked] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		// Old block-record (uuid-carol-old-record) must be gone; the new record uuid is present
		expect(next.blocked).toHaveLength(1)
		expect(next.blocked[0]!.uuid).toBe("uuid-carol-new-record")
		expect(next.blocked[0]!.email).toBe("carol@example.com")
	})

	it("passes the AbortSignal to blockContact when provided", async () => {
		const blockContact = vi.fn().mockResolvedValue("record-uuid-sig")

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { blockContact }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const contact = makeContact({ email: "sig@example.com" })
		const controller = new AbortController()

		await contacts.block({
			userId: contact.userId,
			email: contact.email,
			avatar: contact.avatar ?? undefined,
			nickName: contact.nickName ?? undefined,
			timestamp: contact.timestamp,
			signal: controller.signal
		})

		expect(blockContact).toHaveBeenCalledWith("sig@example.com", { signal: controller.signal })
	})
})

describe("contacts.denyRequest", () => {
	it("removes the denied request from incoming in the query cache update", async () => {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				denyContactRequest: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.denyRequest({ uuid: "req-uuid-1" })

		expect(contactRequestsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]![0]
		const prev = {
			incoming: [{ uuid: "req-uuid-1" }, { uuid: "req-uuid-2" }],
			outgoing: []
		}
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.incoming).toHaveLength(1)
		expect(next.incoming[0]!.uuid).toBe("req-uuid-2")
		expect(next.outgoing).toEqual([])
	})

	it("leaves outgoing untouched and produces empty incoming when the only request is denied", async () => {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { denyContactRequest: vi.fn().mockResolvedValue(undefined) }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.denyRequest({ uuid: "only-req" })

		const update = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]![0]
		const outgoingReq = makeRequest({ uuid: "out-1" })
		const prev = { incoming: [{ uuid: "only-req" }], outgoing: [outgoingReq] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.incoming).toHaveLength(0)
		expect(next.outgoing).toEqual([outgoingReq])
	})

	it("passes the AbortSignal to denyContactRequest when provided", async () => {
		const denyContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { denyContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.denyRequest({ uuid: "req-sig", signal: controller.signal })

		expect(denyContactRequest).toHaveBeenCalledWith("req-sig", { signal: controller.signal })
	})
})

describe("contacts.cancelRequest", () => {
	it("removes the cancelled request from outgoing in the query cache update", async () => {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				cancelContactRequest: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.cancelRequest({ uuid: "req-uuid-out-1" })

		expect(contactRequestsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]![0]
		const prev = {
			incoming: [],
			outgoing: [{ uuid: "req-uuid-out-1" }, { uuid: "req-uuid-out-2" }]
		}
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.outgoing).toHaveLength(1)
		expect(next.outgoing[0]!.uuid).toBe("req-uuid-out-2")
		expect(next.incoming).toEqual([])
	})

	it("passes the AbortSignal to cancelContactRequest when provided", async () => {
		const cancelContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { cancelContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.cancelRequest({ uuid: "req-sig-out", signal: controller.signal })

		expect(cancelContactRequest).toHaveBeenCalledWith("req-sig-out", { signal: controller.signal })
	})
})

describe("contacts.delete", () => {
	it("removes the deleted contact from contacts in the query cache update", async () => {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				deleteContact: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.delete({ uuid: "uuid-del-1" })

		expect(contactsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = {
			contacts: [{ uuid: "uuid-del-1" }, { uuid: "uuid-del-2" }],
			blocked: []
		}
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.contacts).toHaveLength(1)
		expect(next.contacts[0]!.uuid).toBe("uuid-del-2")
	})

	it("passes the AbortSignal to deleteContact when provided", async () => {
		const deleteContact = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { deleteContact }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.delete({ uuid: "uuid-del-sig", signal: controller.signal })

		expect(deleteContact).toHaveBeenCalledWith("uuid-del-sig", { signal: controller.signal })
	})
})

describe("contacts.acceptRequest", () => {
	it("filters the accepted request from incoming in contactRequestsQueryUpdate", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-accept-1" })

		// contactRequestsQueryUpdate called once for incoming filter
		expect(contactRequestsQueryUpdate).toHaveBeenCalledOnce()
		const reqUpdate = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]![0]
		const reqPrev = {
			incoming: [{ uuid: "req-accept-1" }, { uuid: "req-accept-2" }],
			outgoing: []
		}
		const reqNext = (reqUpdate as unknown as { updater: (p: typeof reqPrev) => typeof reqPrev }).updater(reqPrev)
		expect(reqNext.incoming).toHaveLength(1)
		expect(reqNext.incoming[0]!.uuid).toBe("req-accept-2")
		expect(reqNext.outgoing).toEqual([])
	})

	it("invalidates both contacts and contactRequests queries after acceptRequest instead of calling getContacts() inline", async () => {
		// #45 fix: acceptRequest now uses queryClient.invalidateQueries for both caches
		// rather than an inline getContacts() call that could leave them inconsistent.
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-invalidate" })

		// contactsQueryUpdate must NOT be called (no inline getContacts anymore)
		expect(contactsQueryUpdate).not.toHaveBeenCalled()

		// invalidateQueries must be called for both keys
		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
		const calls = vi.mocked(queryClient.invalidateQueries).mock.calls.map(c => (c[0] as { queryKey: string[] }).queryKey[0])
		expect(calls).toContain("useContactsQuery")
		expect(calls).toContain("useContactRequestsQuery")
	})

	it("calls acceptContactRequest with the uuid and no options when no signal is given", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-no-sig" })

		expect(acceptContactRequest).toHaveBeenCalledWith("req-no-sig", undefined)
	})

	it("passes the AbortSignal to acceptContactRequest when provided", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.acceptRequest({ uuid: "req-sig", signal: controller.signal })

		expect(acceptContactRequest).toHaveBeenCalledWith("req-sig", { signal: controller.signal })
	})

	it("still filters incoming request from cache even when the server call succeeds (pre-invalidation optimistic update)", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-partial-ok" })

		// contactRequestsQueryUpdate was called (incoming was filtered)
		expect(contactRequestsQueryUpdate).toHaveBeenCalledOnce()
		const reqUpdate = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]?.[0]
		const reqPrev = {
			incoming: [{ uuid: "req-partial-ok" }, { uuid: "req-other" }],
			outgoing: [] as Array<{ uuid: string }>
		}
		const reqNext = (reqUpdate as unknown as { updater: (p: typeof reqPrev) => typeof reqPrev }).updater(reqPrev)
		expect(reqNext.incoming).toHaveLength(1)
		expect(reqNext.incoming[0]!.uuid).toBe("req-other")

		// contacts is refreshed via invalidation, not a direct cache write
		expect(contactsQueryUpdate).not.toHaveBeenCalled()
	})
})

describe("contacts.unblock", () => {
	it("removes the unblocked entry from blocked by uuid and replaces contacts wholesale", async () => {
		const freshContacts = [makeContact({ email: "dave@example.com", uuid: "uuid-dave" })]
		const unblockContact = vi.fn().mockResolvedValue(undefined)
		const getContacts = vi.fn().mockResolvedValue(freshContacts)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { unblockContact, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.unblock({ uuid: "uuid-blocked-1" })

		expect(contactsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const blockedEntry1 = makeContact({ uuid: "uuid-blocked-1", email: "e1@example.com", nickName: "" })
		const blockedEntry2 = makeContact({ uuid: "uuid-blocked-2", email: "e2@example.com", nickName: "" })
		const staleContacts = [makeContact({ uuid: "uuid-stale", email: "stale@example.com" })]
		const prev = { contacts: staleContacts, blocked: [blockedEntry1, blockedEntry2] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		// blocked is filtered by uuid — only the non-unblocked entry remains
		expect(next.blocked).toHaveLength(1)
		expect(next.blocked[0]!.uuid).toBe("uuid-blocked-2")

		// contacts is fully replaced with fresh SDK data
		expect(next.contacts).toHaveLength(1)
		expect(next.contacts[0]!.uuid).toBe("uuid-dave")
	})

	it("calls unblockContact with the uuid and no options when no signal is given", async () => {
		const unblockContact = vi.fn().mockResolvedValue(undefined)
		const getContacts = vi.fn().mockResolvedValue([])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { unblockContact, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.unblock({ uuid: "uuid-no-sig" })

		expect(unblockContact).toHaveBeenCalledWith("uuid-no-sig", undefined)
	})

	it("passes the AbortSignal to unblockContact and getContacts when provided", async () => {
		const unblockContact = vi.fn().mockResolvedValue(undefined)
		const getContacts = vi.fn().mockResolvedValue([])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { unblockContact, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.unblock({ uuid: "uuid-sig", signal: controller.signal })

		expect(unblockContact).toHaveBeenCalledWith("uuid-sig", { signal: controller.signal })
		expect(getContacts).toHaveBeenCalledWith({ signal: controller.signal })
	})
})

describe("contacts.sendRequest", () => {
	it("calls sendContactRequest and then replaces outgoing with the fresh list", async () => {
		const freshOutgoing = [makeRequest({ uuid: "out-new-1" }), makeRequest({ uuid: "out-new-2" })]
		const sendContactRequest = vi.fn().mockResolvedValue(undefined)
		const listOutgoingContactRequests = vi.fn().mockResolvedValue(freshOutgoing)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { sendContactRequest, listOutgoingContactRequests }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.sendRequest({ email: "newcontact@example.com" })

		expect(sendContactRequest).toHaveBeenCalledWith("newcontact@example.com", undefined)
		expect(listOutgoingContactRequests).toHaveBeenCalledWith(undefined)
		expect(contactRequestsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactRequestsQueryUpdate).mock.calls[0]![0]
		const staleOutgoing = [makeRequest({ uuid: "out-stale" })]
		const prev = { incoming: [], outgoing: staleOutgoing }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		// outgoing is fully replaced with the fresh SDK response
		expect(next.outgoing).toHaveLength(2)
		expect(next.outgoing[0]!.uuid).toBe("out-new-1")
		expect(next.outgoing[1]!.uuid).toBe("out-new-2")
		// incoming is preserved unchanged
		expect(next.incoming).toEqual([])
	})

	it("passes the AbortSignal to sendContactRequest and listOutgoingContactRequests when provided", async () => {
		const sendContactRequest = vi.fn().mockResolvedValue(undefined)
		const listOutgoingContactRequests = vi.fn().mockResolvedValue([])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { sendContactRequest, listOutgoingContactRequests }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.sendRequest({ email: "sig@example.com", signal: controller.signal })

		expect(sendContactRequest).toHaveBeenCalledWith("sig@example.com", { signal: controller.signal })
		expect(listOutgoingContactRequests).toHaveBeenCalledWith({ signal: controller.signal })
	})
})
