import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ContactRequestsQueryData } from "@/features/contacts/queries/contacts"
import type { SocketEvent, UuidStr } from "@filen/sdk-rs"

// contacts.ts imports the sdk client (a Vite `?worker`, unresolvable under node) — mocked to nothing; the
// handler only ever runs the requests-cache patcher, never a worker op.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { CONTACT_REQUESTS_QUERY_KEY } from "@/features/contacts/queries/contacts"
import { handleContactEvent } from "@/features/contacts/lib/socketHandlers"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function contactEvt(inner: Extract<SocketEvent, { type: "contact" }>["inner"]): Extract<SocketEvent, { type: "contact" }> {
	return { type: "contact", inner, contactMessageId: 0n }
}

function requestReceived(
	uuid: string,
	overrides: Partial<Extract<Extract<SocketEvent, { type: "contact" }>["inner"], { type: "contactRequestReceived" }>> = {}
): Extract<SocketEvent, { type: "contact" }>["inner"] {
	return {
		type: "contactRequestReceived",
		uuid: testUuid(uuid),
		senderId: 42,
		senderEmail: "jane@ex.com",
		senderAvatar: undefined,
		senderNickName: "Jane",
		sentTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

function getRequests(): ContactRequestsQueryData | undefined {
	return testQueryClient.getQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY)
}

beforeEach(() => {
	testQueryClient.clear()
	vi.clearAllMocks()
})

describe("contact socket handlers — request received", () => {
	it("splices an incoming request into the requests cache, coercing senderId to a bigint userId", () => {
		testQueryClient.setQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, { incoming: [], outgoing: [] })

		handleContactEvent(contactEvt(requestReceived("req-a")))

		const incoming = getRequests()?.incoming ?? []

		expect(incoming.map(r => r.uuid)).toEqual([testUuid("req-a")])
		expect(incoming[0]?.userId).toBe(42n)
		expect(incoming[0]?.email).toBe("jane@ex.com")
		expect(incoming[0]?.avatar).toBeUndefined()
	})

	it("carries the avatar through when the sender has one", () => {
		testQueryClient.setQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, { incoming: [], outgoing: [] })

		handleContactEvent(contactEvt(requestReceived("req-a", { senderAvatar: "https://x/av.png" })))

		expect(getRequests()?.incoming[0]?.avatar).toBe("https://x/av.png")
	})

	it("lands the request even when nobody has opened the requests page yet (cache miss defaults to empty)", () => {
		handleContactEvent(contactEvt(requestReceived("req-a")))

		expect(getRequests()?.incoming.map(r => r.uuid)).toEqual([testUuid("req-a")])
	})

	it("de-dupes a re-delivered request by uuid rather than appending a duplicate", () => {
		testQueryClient.setQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, { incoming: [], outgoing: [] })

		handleContactEvent(contactEvt(requestReceived("req-a")))
		handleContactEvent(contactEvt(requestReceived("req-a", { senderNickName: "Jane Renamed" })))

		const incoming = getRequests()?.incoming ?? []

		expect(incoming.length).toBe(1)
		expect(incoming[0]?.nickName).toBe("Jane Renamed")
	})

	it("leaves the outgoing list untouched", () => {
		testQueryClient.setQueryData<ContactRequestsQueryData>(CONTACT_REQUESTS_QUERY_KEY, {
			incoming: [],
			outgoing: [{ uuid: testUuid("out"), email: "out@ex.com", nickName: "Out" }]
		})

		handleContactEvent(contactEvt(requestReceived("req-a")))

		expect(getRequests()?.outgoing.map(r => r.uuid)).toEqual([testUuid("out")])
	})
})
