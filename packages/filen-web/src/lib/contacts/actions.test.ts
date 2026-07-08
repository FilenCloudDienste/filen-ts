import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut, UuidStr } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it down
// to the ops these helpers call, mirroring lib/drive/actions.test.ts's mock boundary.
const {
	sendContactRequest,
	listOutgoingContactRequests,
	acceptContactRequest,
	denyContactRequest,
	cancelContactRequest,
	blockContact,
	unblockContact,
	getContacts,
	deleteContact
} = vi.hoisted(() => ({
	sendContactRequest: vi.fn(),
	listOutgoingContactRequests: vi.fn(),
	acceptContactRequest: vi.fn(),
	denyContactRequest: vi.fn(),
	cancelContactRequest: vi.fn(),
	blockContact: vi.fn(),
	unblockContact: vi.fn(),
	getContacts: vi.fn(),
	deleteContact: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		sendContactRequest,
		listOutgoingContactRequests,
		acceptContactRequest,
		denyContactRequest,
		cancelContactRequest,
		blockContact,
		unblockContact,
		getContacts,
		deleteContact
	}
}))

// A bare, unconfigured QueryClient stands in for the real singleton — same rationale as
// drive/actions.test.ts: these helpers only need genuine setQueryData/getQueryData cache mechanics,
// never the production client's OPFS-backed persistence pipeline. queries/contacts.ts's own patchers
// use this same mocked module, so both share one instance.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CONTACTS_QUERY_KEY, CONTACT_REQUESTS_QUERY_KEY } from "@/queries/contacts"
import {
	acceptRequest,
	blockContact as blockContactAction,
	cancelRequest,
	denyRequest,
	removeContact,
	runContactsBulk,
	sendContactRequest as sendContactRequestAction,
	unblockContact as unblockContactAction
} from "@/lib/contacts/actions"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable test label
// into a shape that satisfies it, mirroring drive/actions.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: testUuid("alice"),
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
		uuid: testUuid("bob-blocked"),
		userId: 2n,
		email: "bob@filen.io",
		nickName: "Bob",
		timestamp: 1_700_000_000_000n,
		...overrides
	}
}

function mockIncoming(overrides: Partial<ContactRequestIn> = {}): ContactRequestIn {
	return {
		uuid: testUuid("carol-in"),
		userId: 3n,
		email: "carol@filen.io",
		nickName: "Carol",
		...overrides
	}
}

function mockOutgoing(overrides: Partial<ContactRequestOut> = {}): ContactRequestOut {
	return {
		uuid: testUuid("dave-out"),
		email: "dave@filen.io",
		nickName: "Dave",
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function seedContacts(data: { contacts?: Contact[]; blocked?: BlockedContact[] } = {}): void {
	testQueryClient.setQueryData(CONTACTS_QUERY_KEY, { contacts: data.contacts ?? [], blocked: data.blocked ?? [] })
}

function seedRequests(data: { incoming?: ContactRequestIn[]; outgoing?: ContactRequestOut[] } = {}): void {
	testQueryClient.setQueryData(CONTACT_REQUESTS_QUERY_KEY, { incoming: data.incoming ?? [], outgoing: data.outgoing ?? [] })
}

describe("sendContactRequest", () => {
	it("sends the request, discards the returned uuid, and patches outgoing from a fresh listOutgoingContactRequests", async () => {
		seedRequests({ incoming: [mockIncoming()], outgoing: [] })
		sendContactRequest.mockResolvedValueOnce(testUuid("new-request"))
		const refreshed = [mockOutgoing({ email: "new@filen.io" })]
		listOutgoingContactRequests.mockResolvedValueOnce(refreshed)

		const outcome = await sendContactRequestAction("new@filen.io")

		expect(outcome).toEqual({ status: "success" })
		expect(sendContactRequest).toHaveBeenCalledExactlyOnceWith("new@filen.io")
		expect(listOutgoingContactRequests).toHaveBeenCalledTimes(1)
		const data = testQueryClient.getQueryData<{ incoming: ContactRequestIn[]; outgoing: ContactRequestOut[] }>(
			CONTACT_REQUESTS_QUERY_KEY
		)
		expect(data?.outgoing).toEqual(refreshed)
		expect(data?.incoming).toEqual([mockIncoming()]) // untouched
	})

	it("returns an error outcome without patching when the send itself rejects", async () => {
		seedRequests({ outgoing: [mockOutgoing()] })
		const dto = sdkDto("Forbidden")
		sendContactRequest.mockRejectedValueOnce(dto)

		const outcome = await sendContactRequestAction("blocked@filen.io")

		expect(outcome).toEqual({ status: "error", dto })
		expect(listOutgoingContactRequests).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(CONTACT_REQUESTS_QUERY_KEY)).toEqual({ incoming: [], outgoing: [mockOutgoing()] })
	})

	it("returns an error outcome without patching when the send succeeds but the outgoing refetch rejects", async () => {
		seedRequests({ outgoing: [mockOutgoing()] })
		sendContactRequest.mockResolvedValueOnce(testUuid("new-request"))
		const dto = sdkDto("Timeout")
		listOutgoingContactRequests.mockRejectedValueOnce(dto)

		const outcome = await sendContactRequestAction("new@filen.io")

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(CONTACT_REQUESTS_QUERY_KEY)).toEqual({ incoming: [], outgoing: [mockOutgoing()] })
	})
})

describe("acceptRequest", () => {
	it("accepts, removes the request from incoming immediately, and invalidates both queries rather than synthesizing a contact", async () => {
		const target = mockIncoming()
		const other = mockIncoming({ uuid: testUuid("other-in"), email: "other@filen.io" })
		seedRequests({ incoming: [target, other] })
		seedContacts({ contacts: [mockContact()] })
		acceptContactRequest.mockResolvedValueOnce(testUuid("new-contact"))
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")

		const outcome = await acceptRequest(target.uuid)

		expect(outcome).toEqual({ status: "success" })
		expect(acceptContactRequest).toHaveBeenCalledExactlyOnceWith(target.uuid)
		expect(testQueryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([other])
		// No uuid-based Contact synthesis: the contacts cache is untouched synchronously, only invalidated.
		expect(testQueryClient.getQueryData<{ contacts: Contact[] }>(CONTACTS_QUERY_KEY)?.contacts).toEqual([mockContact()])
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CONTACTS_QUERY_KEY })
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CONTACT_REQUESTS_QUERY_KEY })
	})

	it("returns an error outcome without removing the request or invalidating on rejection", async () => {
		const target = mockIncoming()
		seedRequests({ incoming: [target] })
		const dto = sdkDto("NotFound")
		acceptContactRequest.mockRejectedValueOnce(dto)
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")

		const outcome = await acceptRequest(target.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([target])
		expect(invalidateSpy).not.toHaveBeenCalled()
	})
})

describe("denyRequest", () => {
	it("denies and removes the request from incoming", async () => {
		const target = mockIncoming()
		const other = mockIncoming({ uuid: testUuid("other-in") })
		seedRequests({ incoming: [target, other] })
		denyContactRequest.mockResolvedValueOnce(undefined)

		const outcome = await denyRequest(target.uuid)

		expect(outcome).toEqual({ status: "success" })
		expect(denyContactRequest).toHaveBeenCalledExactlyOnceWith(target.uuid)
		expect(testQueryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([other])
	})

	it("returns an error outcome without patching on rejection", async () => {
		const target = mockIncoming()
		seedRequests({ incoming: [target] })
		const dto = sdkDto("Forbidden")
		denyContactRequest.mockRejectedValueOnce(dto)

		const outcome = await denyRequest(target.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([target])
	})
})

describe("cancelRequest", () => {
	it("cancels and removes the request from outgoing", async () => {
		const target = mockOutgoing()
		const other = mockOutgoing({ uuid: testUuid("other-out") })
		seedRequests({ outgoing: [target, other] })
		cancelContactRequest.mockResolvedValueOnce(undefined)

		const outcome = await cancelRequest(target.uuid)

		expect(outcome).toEqual({ status: "success" })
		expect(cancelContactRequest).toHaveBeenCalledExactlyOnceWith(target.uuid)
		expect(testQueryClient.getQueryData<{ outgoing: ContactRequestOut[] }>(CONTACT_REQUESTS_QUERY_KEY)?.outgoing).toEqual([other])
	})

	it("returns an error outcome without patching on rejection", async () => {
		const target = mockOutgoing()
		seedRequests({ outgoing: [target] })
		const dto = sdkDto("Forbidden")
		cancelContactRequest.mockRejectedValueOnce(dto)

		const outcome = await cancelRequest(target.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<{ outgoing: ContactRequestOut[] }>(CONTACT_REQUESTS_QUERY_KEY)?.outgoing).toEqual([target])
	})
})

describe("blockContact", () => {
	it("blocks by email, moves the contact from contacts to blocked, and synthesizes the BlockedContact from the returned uuid", async () => {
		const contact = mockContact({ avatar: "https://example.com/a.png" })
		const other = mockContact({ uuid: testUuid("other-c"), email: "other@filen.io" })
		seedContacts({ contacts: [contact, other], blocked: [] })
		blockContact.mockResolvedValueOnce(testUuid("new-blocked"))

		const outcome = await blockContactAction(contact)

		expect(outcome).toEqual({ status: "success" })
		expect(blockContact).toHaveBeenCalledExactlyOnceWith(contact.email)
		const data = testQueryClient.getQueryData<{ contacts: Contact[]; blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.contacts).toEqual([other])
		expect(data?.blocked).toEqual([
			{
				uuid: testUuid("new-blocked"),
				userId: contact.userId,
				email: contact.email,
				nickName: contact.nickName,
				timestamp: contact.timestamp,
				avatar: contact.avatar
			}
		])
	})

	it("synthesizes an empty-string nickName when the contact's nickName is undefined (BlockedContact.nickName is non-optional)", async () => {
		const contact = mockContact({ nickName: undefined })
		seedContacts({ contacts: [contact] })
		blockContact.mockResolvedValueOnce(testUuid("new-blocked"))

		await blockContactAction(contact)

		const data = testQueryClient.getQueryData<{ blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.blocked[0]?.nickName).toBe("")
	})

	it("omits the avatar key entirely (not avatar: undefined) when the contact has no avatar", async () => {
		const contact = mockContact()
		delete (contact as { avatar?: string }).avatar
		seedContacts({ contacts: [contact] })
		blockContact.mockResolvedValueOnce(testUuid("new-blocked"))

		await blockContactAction(contact)

		const data = testQueryClient.getQueryData<{ blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.blocked[0]).toBeDefined()
		expect(Object.hasOwn(data?.blocked[0] ?? {}, "avatar")).toBe(false)
	})

	it("filters the source contact out of `contacts` BY EMAIL, not by uuid", async () => {
		// A stale cached row can share the blocked contact's email under a different uuid (e.g. an
		// uncorrected duplicate) — the block is email-keyed server-side, so the local filter must be too.
		const contact = mockContact()
		const staleSameEmail = mockContact({ uuid: testUuid("stale-dup") })
		seedContacts({ contacts: [contact, staleSameEmail] })
		blockContact.mockResolvedValueOnce(testUuid("new-blocked"))

		await blockContactAction(contact)

		const data = testQueryClient.getQueryData<{ contacts: Contact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.contacts).toEqual([])
	})

	it("returns an error outcome without moving the contact on rejection", async () => {
		const contact = mockContact()
		seedContacts({ contacts: [contact], blocked: [] })
		const dto = sdkDto("Forbidden")
		blockContact.mockRejectedValueOnce(dto)

		const outcome = await blockContactAction(contact)

		expect(outcome).toEqual({ status: "error", dto })
		const data = testQueryClient.getQueryData<{ contacts: Contact[]; blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.contacts).toEqual([contact])
		expect(data?.blocked).toEqual([])
	})
})

describe("unblockContact", () => {
	it("unblocks, refetches getContacts (no reconstructable Contact from the SDK), and removes the entry from blocked", async () => {
		const blocked = mockBlockedContact()
		const otherBlocked = mockBlockedContact({ uuid: testUuid("other-blocked") })
		seedContacts({ contacts: [], blocked: [blocked, otherBlocked] })
		unblockContact.mockResolvedValueOnce(undefined)
		const refreshedContacts = [mockContact()]
		getContacts.mockResolvedValueOnce(refreshedContacts)

		const outcome = await unblockContactAction(blocked.uuid)

		expect(outcome).toEqual({ status: "success" })
		expect(unblockContact).toHaveBeenCalledExactlyOnceWith(blocked.uuid)
		expect(getContacts).toHaveBeenCalledTimes(1)
		const data = testQueryClient.getQueryData<{ contacts: Contact[]; blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.contacts).toEqual(refreshedContacts)
		expect(data?.blocked).toEqual([otherBlocked])
	})

	it("returns an error outcome without patching when the unblock op itself rejects", async () => {
		const blocked = mockBlockedContact()
		seedContacts({ blocked: [blocked] })
		const dto = sdkDto("NotFound")
		unblockContact.mockRejectedValueOnce(dto)

		const outcome = await unblockContactAction(blocked.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		expect(getContacts).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData<{ blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)?.blocked).toEqual([blocked])
	})

	it("returns an error outcome without patching when unblock succeeds but the getContacts refetch rejects", async () => {
		const blocked = mockBlockedContact()
		seedContacts({ contacts: [mockContact()], blocked: [blocked] })
		unblockContact.mockResolvedValueOnce(undefined)
		const dto = sdkDto("Timeout")
		getContacts.mockRejectedValueOnce(dto)

		const outcome = await unblockContactAction(blocked.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		const data = testQueryClient.getQueryData<{ contacts: Contact[]; blocked: BlockedContact[] }>(CONTACTS_QUERY_KEY)
		expect(data?.blocked).toEqual([blocked]) // still blocked locally — server-side already unblocked, self-heals on refetch
	})
})

describe("removeContact", () => {
	it("deletes the contact and filters it out of `contacts` by uuid", async () => {
		const target = mockContact()
		const other = mockContact({ uuid: testUuid("other-c"), email: "other@filen.io" })
		seedContacts({ contacts: [target, other] })
		deleteContact.mockResolvedValueOnce(undefined)

		const outcome = await removeContact(target.uuid)

		expect(outcome).toEqual({ status: "success" })
		expect(deleteContact).toHaveBeenCalledExactlyOnceWith(target.uuid)
		expect(testQueryClient.getQueryData<{ contacts: Contact[] }>(CONTACTS_QUERY_KEY)?.contacts).toEqual([other])
	})

	it("returns an error outcome without patching on rejection", async () => {
		const target = mockContact()
		seedContacts({ contacts: [target] })
		const dto = sdkDto("Forbidden")
		deleteContact.mockRejectedValueOnce(dto)

		const outcome = await removeContact(target.uuid)

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<{ contacts: Contact[] }>(CONTACTS_QUERY_KEY)?.contacts).toEqual([target])
	})
})

describe("runContactsBulk", () => {
	it("resolves every item as succeeded when perItem resolves success for all", async () => {
		const items = [mockIncoming(), mockIncoming({ uuid: testUuid("b") })]
		const perItem = vi.fn().mockResolvedValue({ status: "success" } as const)

		const result = await runContactsBulk(items, perItem)

		expect(result).toEqual({ succeeded: items, failed: [] })
		expect(perItem).toHaveBeenCalledTimes(2)
	})

	it("collects a VoidActionOutcome error status as a BulkFailure carrying the original dto, without aborting the rest", async () => {
		const ok = mockIncoming({ uuid: testUuid("ok") })
		const bad = mockIncoming({ uuid: testUuid("bad") })
		const dto = sdkDto("Forbidden")
		const perItem = vi
			.fn()
			.mockResolvedValueOnce({ status: "success" } as const)
			.mockResolvedValueOnce({ status: "error", dto } as const)

		const result = await runContactsBulk([ok, bad], perItem)

		expect(result.succeeded).toEqual([ok])
		expect(result.failed).toEqual([{ item: bad, error: dto }])
	})

	it("composes with a real helper end-to-end: bulk-denying a subset removes exactly those from incoming", async () => {
		const keep = mockIncoming({ uuid: testUuid("keep") })
		const denyA = mockIncoming({ uuid: testUuid("deny-a") })
		const denyB = mockIncoming({ uuid: testUuid("deny-b") })
		seedRequests({ incoming: [keep, denyA, denyB] })
		denyContactRequest.mockResolvedValue(undefined)

		const result = await runContactsBulk([denyA, denyB], item => denyRequest(item.uuid))

		expect(result.succeeded).toEqual([denyA, denyB])
		expect(testQueryClient.getQueryData<{ incoming: ContactRequestIn[] }>(CONTACT_REQUESTS_QUERY_KEY)?.incoming).toEqual([keep])
	})

	it("resolves to an empty split on an empty selection without calling perItem", async () => {
		const perItem = vi.fn()

		const result = await runContactsBulk([], perItem)

		expect(result).toEqual({ succeeded: [], failed: [] })
		expect(perItem).not.toHaveBeenCalled()
	})
})
