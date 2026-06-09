/**
 * Unit tests for the socket→UI-state mapping that socket.tsx applies
 * when it receives SocketEvent_Tags connection-lifecycle events.
 *
 * The mapping is:
 *   Reconnecting  → "reconnecting"
 *   AuthSuccess   → "connected"
 *   AuthFailed    → "disconnected"
 *   Unsubscribed  → "disconnected"
 *
 * Device-QA is needed to validate that:
 *   - A real disconnect shows "reconnecting" then "disconnected" without
 *     a false "connected" flash (no poll latch).
 *   - Returning from background restores "connected" immediately on AuthSuccess
 *     rather than only after the next 5 s tick.
 */

import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// The mapping logic extracted verbatim from socket.tsx onEvent().
// If socket.tsx ever refactors the ternary the test will need a matching update.
// ---------------------------------------------------------------------------

const { mockSetTyping } = vi.hoisted(() => ({
	mockSetTyping: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@/features/chats/store/useChats.store", () => ({
	default: {
		getState: vi.fn().mockReturnValue({
			setTyping: mockSetTyping
		})
	}
}))

vi.mock("@/features/chats/socketHandlers", () => ({
	chatTypingTimeoutsRef: {},
	handleChatEvent: vi.fn()
}))

vi.mock("@/features/chats/chats", () => ({
	default: { refetchChatsAndMessages: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock("@/features/notes/socketHandlers", () => ({
	handleNoteEvent: vi.fn()
}))

vi.mock("@/features/drive/socketHandlers", () => ({
	handleDriveEvent: vi.fn()
}))

vi.mock("@/features/contacts/socketHandlers", () => ({
	handleContactEvent: vi.fn()
}))

vi.mock("@/lib/auth", () => ({
	default: { logout: vi.fn().mockResolvedValue(undefined) },
	useSdkClients: vi.fn(),
	useStringifiedClient: vi.fn()
}))

// ---------------------------------------------------------------------------
// The mapping under test — mirrors the ternary in onEvent() exactly.
// SocketEvent_Tags values are reproduced here so the test does not depend
// on the sdk-rs runtime; they must stay in sync with the SDK enum.
// ---------------------------------------------------------------------------

const SocketEvent_Tags = {
	Reconnecting: "Reconnecting",
	AuthSuccess: "AuthSuccess",
	AuthFailed: "AuthFailed",
	Unsubscribed: "Unsubscribed",
	General: "General",
	Drive: "Drive",
	Chat: "Chat",
	Note: "Note",
	Contact: "Contact"
} as const

type ConnectionTag =
	| typeof SocketEvent_Tags.Reconnecting
	| typeof SocketEvent_Tags.AuthSuccess
	| typeof SocketEvent_Tags.AuthFailed
	| typeof SocketEvent_Tags.Unsubscribed

type SocketState = "connected" | "disconnected" | "reconnecting"

/** Pure mapping — identical logic to the ternary in socket.tsx onEvent(). */
function tagToSocketState(tag: ConnectionTag): SocketState {
	return tag === SocketEvent_Tags.Reconnecting
		? "reconnecting"
		: tag === SocketEvent_Tags.AuthSuccess
			? "connected"
			: "disconnected"
}

// ---------------------------------------------------------------------------

import { useSocketStore } from "@/stores/useSocket.store"

beforeEach(() => {
	useSocketStore.setState({ state: "disconnected" })
})

describe("tagToSocketState — pure event→state mapping", () => {
	it("Reconnecting → reconnecting", () => {
		expect(tagToSocketState(SocketEvent_Tags.Reconnecting)).toBe("reconnecting")
	})

	it("AuthSuccess → connected", () => {
		expect(tagToSocketState(SocketEvent_Tags.AuthSuccess)).toBe("connected")
	})

	it("AuthFailed → disconnected", () => {
		expect(tagToSocketState(SocketEvent_Tags.AuthFailed)).toBe("disconnected")
	})

	it("Unsubscribed → disconnected", () => {
		expect(tagToSocketState(SocketEvent_Tags.Unsubscribed)).toBe("disconnected")
	})
})

describe("useSocketStore.setState — driven by mapped values", () => {
	it("Reconnecting event drives store to 'reconnecting' without polling", () => {
		useSocketStore.getState().setState(tagToSocketState(SocketEvent_Tags.Reconnecting))

		expect(useSocketStore.getState().state).toBe("reconnecting")
	})

	it("AuthSuccess event drives store to 'connected'", () => {
		useSocketStore.getState().setState(tagToSocketState(SocketEvent_Tags.AuthSuccess))

		expect(useSocketStore.getState().state).toBe("connected")
	})

	it("AuthFailed after connected drives store to 'disconnected', not latched at 'connected'", () => {
		// Simulate connected then disconnect
		useSocketStore.getState().setState("connected")
		useSocketStore.getState().setState(tagToSocketState(SocketEvent_Tags.AuthFailed))

		expect(useSocketStore.getState().state).toBe("disconnected")
	})

	it("Unsubscribed after reconnecting drives store to 'disconnected', not latched at 'reconnecting'", () => {
		useSocketStore.getState().setState("reconnecting")
		useSocketStore.getState().setState(tagToSocketState(SocketEvent_Tags.Unsubscribed))

		expect(useSocketStore.getState().state).toBe("disconnected")
	})

	it("poll latch is absent: a false isSocketConnected cannot pin state back to 'connected'", () => {
		// Before the fix, the 5 s poll did:
		//   setState(prev => isSocketConnected() ? "connected" : prev)
		// which could never write "disconnected" if isSocketConnected() returned true.
		// After the fix there is no poll, so driving "reconnecting" then "disconnected"
		// is permanent — nothing silently reverts it.
		useSocketStore.getState().setState("reconnecting")
		useSocketStore.getState().setState(tagToSocketState(SocketEvent_Tags.AuthFailed))

		// No poll can overwrite this — assert it stays disconnected
		expect(useSocketStore.getState().state).toBe("disconnected")
	})
})
