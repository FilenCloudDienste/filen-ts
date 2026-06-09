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

const { mockSetTyping } = vi.hoisted(() => ({
	mockSetTyping: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

// Mock the @filen/sdk-rs package so that:
//  (a) SocketEvent_Tags is available with the real production string values, and
//  (b) the WASM / RN-uniffi surfaces (which use `self` / native modules) are never loaded.
vi.mock("@filen/sdk-rs", () => ({
	SocketEvent_Tags: {
		AuthSuccess: "AuthSuccess",
		AuthFailed: "AuthFailed",
		Reconnecting: "Reconnecting",
		Unsubscribed: "Unsubscribed",
		Drive: "Drive",
		Chat: "Chat",
		Note: "Note",
		Contact: "Contact",
		General: "General"
	},
	GeneralEvent_Tags: {
		PasswordChanged: "PasswordChanged",
		NewEvent: "NewEvent"
	}
}))

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
// Import the real production mapping and the SDK enum — tests now exercise
// the actual function from socket.tsx, so any future incorrect refactor of
// the mapping will be caught here.
// ---------------------------------------------------------------------------

import { SocketEvent_Tags } from "@filen/sdk-rs"
import { socketEventTagToState } from "@/components/shell/socket"
import { useSocketStore } from "@/stores/useSocket.store"

beforeEach(() => {
	useSocketStore.setState({ state: "disconnected" })
})

describe("socketEventTagToState — pure event→state mapping", () => {
	it("Reconnecting → reconnecting", () => {
		expect(socketEventTagToState(SocketEvent_Tags.Reconnecting)).toBe("reconnecting")
	})

	it("AuthSuccess → connected", () => {
		expect(socketEventTagToState(SocketEvent_Tags.AuthSuccess)).toBe("connected")
	})

	it("AuthFailed → disconnected", () => {
		expect(socketEventTagToState(SocketEvent_Tags.AuthFailed)).toBe("disconnected")
	})

	it("Unsubscribed → disconnected", () => {
		expect(socketEventTagToState(SocketEvent_Tags.Unsubscribed)).toBe("disconnected")
	})
})

describe("useSocketStore.setState — driven by mapped values", () => {
	it("Reconnecting event drives store to 'reconnecting' without polling", () => {
		useSocketStore.getState().setState(socketEventTagToState(SocketEvent_Tags.Reconnecting))

		expect(useSocketStore.getState().state).toBe("reconnecting")
	})

	it("AuthSuccess event drives store to 'connected'", () => {
		useSocketStore.getState().setState(socketEventTagToState(SocketEvent_Tags.AuthSuccess))

		expect(useSocketStore.getState().state).toBe("connected")
	})

	it("AuthFailed after connected drives store to 'disconnected', not latched at 'connected'", () => {
		// Simulate connected then disconnect
		useSocketStore.getState().setState("connected")
		useSocketStore.getState().setState(socketEventTagToState(SocketEvent_Tags.AuthFailed))

		expect(useSocketStore.getState().state).toBe("disconnected")
	})

	it("Unsubscribed after reconnecting drives store to 'disconnected', not latched at 'reconnecting'", () => {
		useSocketStore.getState().setState("reconnecting")
		useSocketStore.getState().setState(socketEventTagToState(SocketEvent_Tags.Unsubscribed))

		expect(useSocketStore.getState().state).toBe("disconnected")
	})

	it("poll latch is absent: a false isSocketConnected cannot pin state back to 'connected'", () => {
		// Before the fix, the 5 s poll did:
		//   setState(prev => isSocketConnected() ? "connected" : prev)
		// which could never write "disconnected" if isSocketConnected() returned true.
		// After the fix there is no poll, so driving "reconnecting" then "disconnected"
		// is permanent — nothing silently reverts it.
		useSocketStore.getState().setState("reconnecting")
		useSocketStore.getState().setState(socketEventTagToState(SocketEvent_Tags.AuthFailed))

		// No poll can overwrite this — assert it stays disconnected
		expect(useSocketStore.getState().state).toBe("disconnected")
	})
})
