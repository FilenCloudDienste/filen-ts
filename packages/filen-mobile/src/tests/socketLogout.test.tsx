// @vitest-environment happy-dom

// The shell socket at logout. It unmounts only once the logout's wipe flipped isAuthed, and a destroyed
// listener still hands JS the events already queued for it, so the "logout" event must end the session
// here: the listener goes, late events are dropped, and no listener comes back.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement } from "react"
import { render, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

const h = vi.hoisted(() => {
	const handle = { uniffiDestroy: vi.fn() }

	return {
		handle,
		client: {
			addEventListener: vi.fn(),
			isSocketConnected: vi.fn(() => true)
		},
		appStateHandlers: [] as ((state: string) => void)[],
		handleDriveEvent: vi.fn(async () => undefined)
	}
})

vi.mock("react-native", () => ({
	AppState: {
		currentState: "active",
		addEventListener: (_type: string, handler: (state: string) => void) => {
			h.appStateHandlers.push(handler)

			return {
				remove: () => {
					h.appStateHandlers.splice(h.appStateHandlers.indexOf(handler), 1)
				}
			}
		}
	}
}))
vi.mock("@filen/sdk-rs", () => ({
	SocketEvent_Tags: {
		AuthSuccess: "AuthSuccess",
		AuthFailed: "AuthFailed",
		Reconnecting: "Reconnecting",
		Unsubscribed: "Unsubscribed",
		Drive: "Drive",
		DriveMalformed: "DriveMalformed",
		Chat: "Chat",
		Note: "Note",
		Contact: "Contact",
		General: "General"
	},
	GeneralEvent_Tags: { PasswordChanged: "PasswordChanged", NewEvent: "NewEvent" },
	ChatEvent_Tags: { Typing: "Typing" },
	ListenerHandle: class {}
}))
vi.mock("@/lib/auth", () => ({
	default: { logout: vi.fn() },
	useSdkClients: () => ({ authedSdkClient: h.client }),
	useStringifiedClient: () => ({ userId: 7n })
}))
vi.mock("@/features/chats/store/useChats.store", () => ({ default: { getState: () => ({ setTyping: vi.fn() }) } }))
vi.mock("@/features/chats/chats", () => ({ default: { refetchChatsAndMessages: vi.fn(async () => undefined) } }))
vi.mock("@/features/chats/socketHandlers", () => ({ chatTypingTimeoutsRef: {}, handleChatEvent: vi.fn() }))
vi.mock("@/features/notes/socketHandlers", () => ({ handleNoteEvent: vi.fn() }))
vi.mock("@/features/drive/socketHandlers", () => ({ handleDriveEvent: h.handleDriveEvent, handleDriveMalformedEvent: vi.fn() }))
vi.mock("@/features/contacts/socketHandlers", () => ({ handleContactEvent: vi.fn() }))
vi.mock("@/queries/socketSession", () => ({ noteSocketDataEvent: vi.fn() }))

import Socket from "@/components/shell/socket"
import events from "@/lib/events"
import useSocketStore from "@/stores/useSocket.store"
import type { SocketEvent } from "@filen/sdk-rs"

type Listener = { onEvent: (event: SocketEvent) => void }

const driveEvent = { tag: "Drive", inner: [{ inner: { tag: "FileNew", inner: [{}] } }] } as unknown as SocketEvent

async function mountRegistered(): Promise<Listener> {
	render(createElement(Socket))

	await waitFor(() => expect(h.client.addEventListener).toHaveBeenCalledOnce())

	return h.client.addEventListener.mock.calls[0]?.[0] as Listener
}

beforeEach(() => {
	h.handle.uniffiDestroy.mockClear()
	h.client.addEventListener.mockReset().mockResolvedValue(h.handle)
	h.handleDriveEvent.mockClear()
	h.appStateHandlers.length = 0
	useSocketStore.setState({ state: "disconnected" })
})

afterEach(() => {
	cleanup()
})

describe("the shell socket at logout", () => {
	it("destroys the listener and drops every event still queued for JS", async () => {
		const listener = await mountRegistered()

		listener.onEvent(driveEvent)

		await waitFor(() => expect(h.handleDriveEvent).toHaveBeenCalledOnce())

		events.emit("logout")

		await waitFor(() => expect(h.handle.uniffiDestroy).toHaveBeenCalledOnce())

		expect(useSocketStore.getState().state).toBe("disconnected")

		listener.onEvent(driveEvent)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(h.handleDriveEvent).toHaveBeenCalledOnce()
	})

	it("registers no listener for the ended session when the app returns to the foreground", async () => {
		await mountRegistered()

		events.emit("logout")

		await waitFor(() => expect(h.handle.uniffiDestroy).toHaveBeenCalledOnce())

		for (const handler of [...h.appStateHandlers]) {
			handler("background")
			handler("active")
		}

		await new Promise(resolve => setTimeout(resolve, 0))

		expect(h.client.addEventListener).toHaveBeenCalledOnce()
	})

	it("a registration still in flight when the logout lands is destroyed once it completes", async () => {
		let completeRegistration = () => {}

		h.client.addEventListener.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					completeRegistration = () => resolve(h.handle)
				})
		)

		render(createElement(Socket))

		await waitFor(() => expect(h.client.addEventListener).toHaveBeenCalledOnce())

		events.emit("logout")
		completeRegistration()

		await waitFor(() => expect(h.handle.uniffiDestroy).toHaveBeenCalledOnce())
	})
})
