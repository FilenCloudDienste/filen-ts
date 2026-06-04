import { vi, describe, it, expect, beforeEach } from "vitest"

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
	})
}))

vi.mock("@/features/contacts/queries/useContactRequests.query", () => ({
	contactRequestsQueryUpdate: vi.fn((opts: { updater: (prev: unknown) => unknown }) => {
		contactRequestsQueryUpdates.push(opts)
	})
}))

import auth from "@/lib/auth"
import contacts from "@/features/contacts/contacts"
import { contactsQueryUpdate } from "@/features/contacts/queries/useContacts.query"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/useContactRequests.query"

function makeContact(overrides?: {
	uuid?: string
	userId?: number
	email?: string
	avatar?: string | null
	nickName?: string | null
	timestamp?: number
}) {
	return {
		uuid: "aaaa-1111",
		userId: 1,
		email: "alice@example.com",
		avatar: null,
		nickName: null,
		timestamp: 1000,
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
	it("throws 'Contact not found' when the contact does not exist in the fetched list", async () => {
		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				getContacts: vi.fn().mockResolvedValue([]),
				blockContact: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await expect(contacts.block({ email: "nobody@example.com" })).rejects.toThrow("Contact not found")
	})

	it("does not call blockContact when the contact is not found", async () => {
		const blockContact = vi.fn()

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				getContacts: vi.fn().mockResolvedValue([]),
				blockContact
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await expect(contacts.block({ email: "ghost@example.com" })).rejects.toThrow()
		expect(blockContact).not.toHaveBeenCalled()
	})

	it("moves the contact from contacts to blocked in the query cache update", async () => {
		const alice = makeContact({ email: "alice@example.com", uuid: "uuid-alice", userId: 42, nickName: "Al" })

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				getContacts: vi.fn().mockResolvedValue([alice]),
				blockContact: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({ email: "alice@example.com" })

		expect(contactsQueryUpdate).toHaveBeenCalledOnce()

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [alice], blocked: [] as (typeof alice)[] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.contacts).toHaveLength(0)
		expect(next.blocked).toHaveLength(1)
		expect(next.blocked[0]!.uuid).toBe("uuid-alice")
		expect(next.blocked[0]!.userId).toBe(42)
		expect(next.blocked[0]!.nickName).toBe("Al")
	})

	it("uses empty string for nickName when the contact has no nickName", async () => {
		const bob = makeContact({ email: "bob@example.com", uuid: "uuid-bob", nickName: null })

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				getContacts: vi.fn().mockResolvedValue([bob]),
				blockContact: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({ email: "bob@example.com" })

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [bob], blocked: [] as (typeof bob)[] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		expect(next.blocked[0]!.nickName).toBe("")
	})

	it("deduplicates an already-blocked entry identified by email before inserting the new one", async () => {
		// existingBlocked has the SAME email but a DIFFERENT uuid — exercises the email-based filter
		const carol = makeContact({ email: "carol@example.com", uuid: "uuid-carol-new" })
		const existingBlocked = { ...carol, uuid: "uuid-carol-old", nickName: "" }

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: {
				getContacts: vi.fn().mockResolvedValue([carol]),
				blockContact: vi.fn().mockResolvedValue(undefined)
			}
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.block({ email: "carol@example.com" })

		const update = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const prev = { contacts: [carol], blocked: [existingBlocked] }
		const next = (update as unknown as { updater: (p: typeof prev) => typeof prev }).updater(prev)

		// Old entry (uuid-carol-old) must be gone; the freshly-blocked entry (uuid-carol-new) is present
		expect(next.blocked).toHaveLength(1)
		expect(next.blocked[0]!.uuid).toBe("uuid-carol-new")
		expect(next.blocked[0]!.email).toBe("carol@example.com")
	})

	it("passes the AbortSignal to getContacts and blockContact when provided", async () => {
		const getContacts = vi.fn().mockResolvedValue([makeContact({ email: "sig@example.com" })])
		const blockContact = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { getContacts, blockContact }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.block({ email: "sig@example.com", signal: controller.signal })

		expect(getContacts).toHaveBeenCalledWith({ signal: controller.signal })
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
	it("filters the accepted request from incoming and updates contacts wholesale", async () => {
		const alice = makeContact({ email: "alice@example.com", uuid: "uuid-alice" })
		const getContacts = vi.fn().mockResolvedValue([alice])
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest, getContacts }
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

	it("replaces the contacts list wholesale in contactsQueryUpdate after acceptRequest", async () => {
		const freshContacts = [
			makeContact({ email: "bob@example.com", uuid: "uuid-bob" }),
			makeContact({ email: "carol@example.com", uuid: "uuid-carol" })
		]
		const getContacts = vi.fn().mockResolvedValue(freshContacts)
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-accept-fresh" })

		expect(contactsQueryUpdate).toHaveBeenCalledOnce()
		const contactUpdate = vi.mocked(contactsQueryUpdate).mock.calls[0]![0]
		const staleContacts = [makeContact({ email: "stale@example.com", uuid: "uuid-stale" })]
		const contactPrev = { contacts: staleContacts, blocked: [] }
		const contactNext = (
			contactUpdate as unknown as { updater: (p: typeof contactPrev) => typeof contactPrev }
		).updater(contactPrev)

		// contacts is fully replaced with the fresh list fetched from the SDK
		expect(contactNext.contacts).toHaveLength(2)
		expect(contactNext.contacts[0]!.uuid).toBe("uuid-bob")
		expect(contactNext.contacts[1]!.uuid).toBe("uuid-carol")
		// blocked is preserved unchanged
		expect(contactNext.blocked).toEqual([])
	})

	it("calls acceptContactRequest with the uuid and no options when no signal is given", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)
		const getContacts = vi.fn().mockResolvedValue([])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		await contacts.acceptRequest({ uuid: "req-no-sig" })

		expect(acceptContactRequest).toHaveBeenCalledWith("req-no-sig", undefined)
	})

	it("passes the AbortSignal to acceptContactRequest and getContacts when provided", async () => {
		const acceptContactRequest = vi.fn().mockResolvedValue(undefined)
		const getContacts = vi.fn().mockResolvedValue([])

		vi.mocked(auth.getSdkClients).mockResolvedValue({
			authedSdkClient: { acceptContactRequest, getContacts }
		} as unknown as Awaited<ReturnType<typeof auth.getSdkClients>>)

		const controller = new AbortController()
		await contacts.acceptRequest({ uuid: "req-sig", signal: controller.signal })

		expect(acceptContactRequest).toHaveBeenCalledWith("req-sig", { signal: controller.signal })
		expect(getContacts).toHaveBeenCalledWith({ signal: controller.signal })
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
