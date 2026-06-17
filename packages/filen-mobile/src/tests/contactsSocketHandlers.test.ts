import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ---------------------------------------------------------------------------
// Hoisted state — captured updater callback from the mocked query function
// ---------------------------------------------------------------------------

const { capturedUpdaters, mockContactRequestsQueryUpdate } = vi.hoisted(() => {
	const capturedUpdaters: Array<(prev: { incoming: unknown[]; outgoing: unknown[] }) => { incoming: unknown[]; outgoing: unknown[] }> = []

	const mockContactRequestsQueryUpdate = vi.fn(
		({
			updater
		}: {
			updater: (prev: { incoming: unknown[]; outgoing: unknown[] }) => { incoming: unknown[]; outgoing: unknown[] }
		}) => {
			capturedUpdaters.push(updater)
		}
	)

	return {
		capturedUpdaters,
		mockContactRequestsQueryUpdate
	}
})

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that pull in the modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/features/contacts/queries/useContactRequests.query", () => ({
	contactRequestsQueryUpdate: mockContactRequestsQueryUpdate
}))

vi.mock("@filen/sdk-rs", () => ({
	ContactEvent_Tags: {
		ContactRequestReceived: "ContactRequestReceived"
	},
	SocketEvent_Tags: {
		Contact: "Contact"
	}
}))

// ---------------------------------------------------------------------------
// Import the unit under test AFTER all vi.mock declarations
// ---------------------------------------------------------------------------

import { handleContactEvent, type ContactSocketEvent } from "@/features/contacts/socketHandlers"
import { ContactEvent_Tags, SocketEvent_Tags } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Helpers — build minimal socket-event shapes matching the handler's destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → ContactEvent_Tags.*
//   const [inner] = eventInner.inner.inner
//   inner.uuid            → contact request uuid string
// ---------------------------------------------------------------------------

function makeContactRequestReceivedEvent(requestData: {
	uuid: string
	senderId: bigint
	senderEmail: string
	senderAvatar: string | null
	senderNickName: string | null
}): ContactSocketEvent {
	return {
		tag: SocketEvent_Tags.Contact,
		inner: [
			{
				inner: {
					tag: ContactEvent_Tags.ContactRequestReceived,
					inner: [requestData]
				}
			}
		]
	} as unknown as ContactSocketEvent
}

function makeUnknownTagEvent(): ContactSocketEvent {
	return {
		tag: SocketEvent_Tags.Contact,
		inner: [
			{
				inner: {
					tag: "UnknownEventTagThatDoesNotExist",
					inner: [{}]
				}
			}
		]
	} as unknown as ContactSocketEvent
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleContactEvent — contacts socket handler", () => {
	beforeEach(() => {
		capturedUpdaters.length = 0
		mockContactRequestsQueryUpdate.mockClear()
	})

	// -------------------------------------------------------------------------
	// #52 — ContactEvent_Tags.ContactRequestReceived
	// -------------------------------------------------------------------------

	describe("ContactEvent_Tags.ContactRequestReceived", () => {
		it("calls contactRequestsQueryUpdate exactly once", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-1",
					senderId: 100n,
					senderEmail: "sender@example.com",
					senderAvatar: null,
					senderNickName: null
				})
			})

			expect(mockContactRequestsQueryUpdate).toHaveBeenCalledOnce()
		})

		it("appends the new request to an empty incoming list", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-1",
					senderId: 100n,
					senderEmail: "sender@example.com",
					senderAvatar: "avatar-url",
					senderNickName: "Nick"
				})
			})

			const updater = capturedUpdaters[0]
			expect(updater).toBeDefined()

			const prev = { incoming: [], outgoing: [] }
			const result = updater!(prev)

			expect(result.incoming).toHaveLength(1)
			expect(result.incoming[0]).toEqual({
				uuid: "req-uuid-1",
				userId: 100n,
				email: "sender@example.com",
				avatar: "avatar-url",
				nickName: "Nick"
			})
		})

		it("appends the new request when there are existing non-duplicate entries", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-2",
					senderId: 200n,
					senderEmail: "second@example.com",
					senderAvatar: null,
					senderNickName: null
				})
			})

			const updater = capturedUpdaters[0]!
			const prev = {
				incoming: [
					{
						uuid: "req-uuid-1",
						userId: 100n,
						email: "first@example.com",
						avatar: null,
						nickName: null
					}
				],
				outgoing: []
			}
			const result = updater(prev)

			expect(result.incoming).toHaveLength(2)
			expect(result.incoming[1]).toEqual({
				uuid: "req-uuid-2",
				userId: 200n,
				email: "second@example.com",
				avatar: null,
				nickName: null
			})
		})

		it("deduplicates: when an existing request has the same uuid, only one entry with the new data remains", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-1",
					senderId: 100n,
					senderEmail: "updated@example.com",
					senderAvatar: "new-avatar",
					senderNickName: "UpdatedNick"
				})
			})

			const updater = capturedUpdaters[0]!
			const prev = {
				incoming: [
					{
						uuid: "req-uuid-1",
						userId: 99n,
						email: "old@example.com",
						avatar: "old-avatar",
						nickName: "OldNick"
					},
					{
						uuid: "req-uuid-other",
						userId: 200n,
						email: "other@example.com",
						avatar: null,
						nickName: null
					}
				],
				outgoing: []
			}
			const result = updater(prev)

			// Only one entry with req-uuid-1 (deduplicated)
			const matching = result.incoming.filter((r: unknown) => (r as { uuid: string }).uuid === "req-uuid-1")
			expect(matching).toHaveLength(1)

			// The entry has the new data (appended at the end after filter)
			expect(matching[0]).toEqual({
				uuid: "req-uuid-1",
				userId: 100n,
				email: "updated@example.com",
				avatar: "new-avatar",
				nickName: "UpdatedNick"
			})
		})

		it("deduplicates: the other unrelated entry is preserved", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-1",
					senderId: 100n,
					senderEmail: "sender@example.com",
					senderAvatar: null,
					senderNickName: null
				})
			})

			const updater = capturedUpdaters[0]!
			const prev = {
				incoming: [
					{ uuid: "req-uuid-1", userId: 99n, email: "old@example.com", avatar: null, nickName: null },
					{ uuid: "req-uuid-other", userId: 200n, email: "other@example.com", avatar: null, nickName: null }
				],
				outgoing: []
			}
			const result = updater(prev)

			const other = result.incoming.find((r: unknown) => (r as { uuid: string }).uuid === "req-uuid-other")
			expect(other).toBeDefined()
			expect(other).toMatchObject({ uuid: "req-uuid-other", userId: 200n })
		})

		it("preserves the outgoing list unchanged", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "req-uuid-1",
					senderId: 100n,
					senderEmail: "sender@example.com",
					senderAvatar: null,
					senderNickName: null
				})
			})

			const updater = capturedUpdaters[0]!
			const existingOutgoing = [{ uuid: "out-1", userId: 500n, email: "out@example.com", avatar: null, nickName: null }]
			const prev = { incoming: [], outgoing: existingOutgoing }
			const result = updater(prev)

			expect(result.outgoing).toBe(existingOutgoing)
		})

		it("maps inner event fields to the correct schema: uuid→uuid, senderId→userId, senderEmail→email, senderAvatar→avatar, senderNickName→nickName", async () => {
			await handleContactEvent({
				event: makeContactRequestReceivedEvent({
					uuid: "schema-uuid",
					senderId: 42n,
					senderEmail: "schema@test.com",
					senderAvatar: "some-avatar",
					senderNickName: "SchemaNick"
				})
			})

			const updater = capturedUpdaters[0]!
			const result = updater({ incoming: [], outgoing: [] })

			expect(result.incoming[0]).toEqual({
				uuid: "schema-uuid",
				userId: 42n,
				email: "schema@test.com",
				avatar: "some-avatar",
				nickName: "SchemaNick"
			})
		})
	})

	// -------------------------------------------------------------------------
	// #52 — default branch throws 'Unhandled contact event'
	// -------------------------------------------------------------------------

	describe("default case — unhandled event tag", () => {
		it("throws 'Unhandled contact event' for an unknown tag", async () => {
			await expect(handleContactEvent({ event: makeUnknownTagEvent() })).rejects.toThrow("Unhandled contact event")
		})

		it("does NOT call contactRequestsQueryUpdate when the event tag is unknown", async () => {
			await expect(handleContactEvent({ event: makeUnknownTagEvent() })).rejects.toThrow()

			expect(mockContactRequestsQueryUpdate).not.toHaveBeenCalled()
		})
	})
})
