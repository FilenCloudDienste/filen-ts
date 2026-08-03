import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { SocketEvent, UuidStr } from "@filen/sdk-rs"

// events.ts imports the sdk client (a Vite `?worker`, unresolvable under node) — mocked to nothing; the
// handler only reads/invalidates the events cache, never a worker op.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

// performLogout wires the real worker-backed teardown collaborators — mocked at the seam so its heavy
// import graph stays out of node and the force-logout call is observable.
const { performLogout } = vi.hoisted(() => ({
	performLogout: vi.fn<(options?: { forced?: boolean }) => Promise<boolean>>(() => Promise.resolve(true))
}))

vi.mock("@/features/shell/lib/performLogout", () => ({ performLogout }))

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { EVENTS_QUERY_KEY } from "@/features/settings/queries/events"
import { handleGeneralEvent } from "@/features/shell/lib/generalSocketHandlers"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function generalEvt(inner: Extract<SocketEvent, { type: "general" }>["inner"]): Extract<SocketEvent, { type: "general" }> {
	return { type: "general", inner, generalMessageId: 0n }
}

function newEvent(): Extract<SocketEvent, { type: "general" }>["inner"] {
	return { type: "newEvent", uuid: testUuid("evt"), eventType: "fileUploaded", timestamp: 1_700_000_000_000n, info: "{}" }
}

beforeEach(() => {
	testQueryClient.clear()
	vi.clearAllMocks()
})

describe("general socket handlers", () => {
	// `forced` is the whole security property of this arm: the server already revoked the session, so the
	// unsaved-preview prompt may delay the wipe but must never cancel it.
	it("passwordChanged forces the unified logout, uncancellable", () => {
		handleGeneralEvent(generalEvt({ type: "passwordChanged" }))

		expect(performLogout).toHaveBeenCalledExactlyOnceWith({ forced: true })
	})

	it("logs a failed force-logout instead of swallowing it", async () => {
		performLogout.mockRejectedValueOnce(new Error("wipe failed"))

		handleGeneralEvent(generalEvt({ type: "passwordChanged" }))
		await Promise.resolve()
		await Promise.resolve()

		expect(logError).toHaveBeenCalledTimes(1)
	})

	it("newEvent refetches the events cache when it has already been loaded", () => {
		testQueryClient.setQueryData(EVENTS_QUERY_KEY, [])
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleGeneralEvent(generalEvt(newEvent()))

		expect(invalidate).toHaveBeenCalledWith({ queryKey: EVENTS_QUERY_KEY })
	})

	it("newEvent is a no-op when the events list was never opened (no phantom refetch)", () => {
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleGeneralEvent(generalEvt(newEvent()))

		expect(invalidate).not.toHaveBeenCalled()
		expect(performLogout).not.toHaveBeenCalled()
	})
})
