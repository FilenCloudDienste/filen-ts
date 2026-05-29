import { vi, describe, it, expect, beforeEach } from "vitest"

const contactsQueryUpdates: Array<{ updater: (prev: unknown) => unknown }> = []
const contactRequestsQueryUpdates: Array<{ updater: (prev: unknown) => unknown }> = []

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn()
	}
}))

vi.mock("@/queries/useContacts.query", () => ({
	contactsQueryUpdate: vi.fn((opts: { updater: (prev: unknown) => unknown }) => {
		contactsQueryUpdates.push(opts)
	})
}))

vi.mock("@/queries/useContactRequests.query", () => ({
	contactRequestsQueryUpdate: vi.fn((opts: { updater: (prev: unknown) => unknown }) => {
		contactRequestsQueryUpdates.push(opts)
	})
}))

import auth from "@/lib/auth"
import contacts from "@/lib/contacts"
import { contactsQueryUpdate } from "@/queries/useContacts.query"
import { contactRequestsQueryUpdate } from "@/queries/useContactRequests.query"

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

	it("deduplicates an already-blocked entry before inserting the new one", async () => {
		const carol = makeContact({ email: "carol@example.com", uuid: "uuid-carol" })
		const existingBlocked = { ...carol, nickName: "" }

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

		expect(next.blocked).toHaveLength(1)
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
})
