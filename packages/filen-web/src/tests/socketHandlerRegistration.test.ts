import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { SocketEvent } from "@filen/sdk-rs"

// Each domain's handler is tested against its own events elsewhere (driveSocketHandlers.test.ts et al.),
// always by calling handle*Event directly — which leaves the one line that decides WHICH event category
// each handler ever receives unexercised. A wrong category here is invisible at every other layer and
// silently disables a whole domain's realtime cache patching, so it gets its own pinning.

// The registry itself is exercised by the real module in socket.test.ts; here it is a spy so the
// registration call is observable (dispatch is module-private, so nothing else can reach it).
const { registerSocketHandler, unregister } = vi.hoisted(() => {
	const unregister = vi.fn()

	return {
		unregister,
		registerSocketHandler: vi.fn<(type: string, handler: (event: SocketEvent) => void) => () => void>(() => unregister)
	}
})

vi.mock("@/lib/sdk/socket", () => ({
	registerSocketHandler,
	// The notes/chats handlers pull this in at module scope; the registration path never calls it.
	decryptedOrSkip: vi.fn()
}))

// Every domain's handler graph reaches the sdk client (a Vite `?worker`, unresolvable under node) and
// the shared query client — the same mock boundary the per-domain handler tests use.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/shell/lib/performLogout", () => ({ performLogout: vi.fn(() => Promise.resolve(true)) }))

import { registerDriveSocketHandlers, handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { registerGeneralSocketHandlers, handleGeneralEvent } from "@/features/shell/lib/generalSocketHandlers"
import { registerNoteSocketHandlers, handleNoteEvent } from "@/features/notes/lib/socketHandlers"
import { registerChatSocketHandlers, handleChatEvent, handleReconnecting, handleAuthSuccess } from "@/features/chats/lib/socketHandlers"
import { registerContactSocketHandlers, handleContactEvent } from "@/features/contacts/lib/socketHandlers"

// The four domains that subscribe exactly one category.
const SINGLE_REGISTRATIONS = [
	{ category: "drive", register: registerDriveSocketHandlers, handler: handleDriveEvent },
	{ category: "general", register: registerGeneralSocketHandlers, handler: handleGeneralEvent },
	{ category: "note", register: registerNoteSocketHandlers, handler: handleNoteEvent },
	{ category: "contact", register: registerContactSocketHandlers, handler: handleContactEvent }
] as const

beforeEach(() => {
	vi.clearAllMocks()
})

describe("socket handler registration", () => {
	it.each(SINGLE_REGISTRATIONS)("subscribes $category events to its own handler, once", ({ category, register, handler }) => {
		register()

		expect(registerSocketHandler).toHaveBeenCalledExactlyOnceWith(category, handler)
	})

	it.each(SINGLE_REGISTRATIONS)("hands back the registry's own unregister fn for $category", ({ register }) => {
		expect(register()).toBe(unregister)
	})

	// Chats is the one domain with more than one subscription: the thread cache patcher plus the two
	// connection-lifecycle handlers it needs to resync after a drop.
	it("subscribes the chat thread handler alongside its two connection-lifecycle handlers", () => {
		registerChatSocketHandlers()

		expect(registerSocketHandler.mock.calls).toEqual([
			["chat", handleChatEvent],
			["reconnecting", handleReconnecting],
			["authSuccess", handleAuthSuccess]
		])
	})

	it("the chat disposer releases all three of its subscriptions, not just the first", () => {
		registerChatSocketHandlers()()

		expect(unregister).toHaveBeenCalledTimes(3)
	})

	it("no two domains claim the same category", () => {
		for (const { register } of SINGLE_REGISTRATIONS) {
			register()
		}

		registerChatSocketHandlers()

		const categories = registerSocketHandler.mock.calls.map(call => call[0])

		expect(new Set(categories).size).toBe(categories.length)
	})
})
