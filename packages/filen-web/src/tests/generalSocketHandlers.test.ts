import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { SocketEvent } from "@filen/sdk-rs"

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
import { testUuid } from "@/tests/support/uuid"

function generalEvt(inner: Extract<SocketEvent, { type: "general" }>["inner"]): Extract<SocketEvent, { type: "general" }> {
	return { type: "general", inner, generalMessageId: 0n }
}

function newEvent(): Extract<SocketEvent, { type: "general" }>["inner"] {
	return { type: "newEvent", uuid: testUuid("evt"), eventType: "fileUploaded", timestamp: 1_700_000_000_000n, info: "{}" }
}

// Mounts the events list the way its screen does, with data fresh so mounting alone reads nothing.
function mountEvents(queryFn: (context: { signal: AbortSignal }) => Promise<never[]>): () => void {
	return new QueryObserver(testQueryClient, { queryKey: EVENTS_QUERY_KEY, queryFn, staleTime: Infinity }).subscribe(() => undefined)
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

	it("newEvent marks a loaded but unmounted events cache stale without reading", () => {
		testQueryClient.setQueryData(EVENTS_QUERY_KEY, [])

		handleGeneralEvent(generalEvt(newEvent()))

		const query = testQueryClient.getQueryCache().find({ queryKey: EVENTS_QUERY_KEY, exact: true })

		expect(query?.state.isInvalidated).toBe(true)
		expect(query?.state.fetchStatus).toBe("idle")
	})

	it("newEvent refetches a mounted events list", async () => {
		const queryFn = vi.fn(() => Promise.resolve([]))

		testQueryClient.setQueryData(EVENTS_QUERY_KEY, [])
		const unsubscribe = mountEvents(queryFn)

		handleGeneralEvent(generalEvt(newEvent()))
		await vi.waitFor(() => {
			expect(testQueryClient.getQueryState(EVENTS_QUERY_KEY)?.fetchStatus).toBe("idle")
		})

		expect(queryFn).toHaveBeenCalledTimes(1)
		unsubscribe()
	})

	// A burst must not restart the read in flight per event: it completes, then one read follows the last event.
	it("newEvent joins a read in flight and reads once more after it, however many events arrive", async () => {
		const pending: { signal: AbortSignal; resolve: (value: never[]) => void }[] = []
		const queryFn = vi.fn(
			({ signal }: { signal: AbortSignal }) =>
				new Promise<never[]>(resolve => {
					pending.push({ signal, resolve })
				})
		)

		testQueryClient.setQueryData(EVENTS_QUERY_KEY, [])
		const unsubscribe = mountEvents(queryFn)
		const firstRead = testQueryClient.refetchQueries({ queryKey: EVENTS_QUERY_KEY, exact: true })

		expect(queryFn).toHaveBeenCalledTimes(1)

		for (let i = 0; i < 5; i++) {
			handleGeneralEvent(generalEvt(newEvent()))
		}

		expect(queryFn).toHaveBeenCalledTimes(1)
		pending[0]?.resolve([])
		await firstRead
		await vi.waitFor(() => {
			expect(queryFn).toHaveBeenCalledTimes(2)
		})

		expect(pending[0]?.signal.aborted).toBe(false)
		pending[1]?.resolve([])
		await vi.waitFor(() => {
			expect(testQueryClient.getQueryState(EVENTS_QUERY_KEY)?.fetchStatus).toBe("idle")
		})

		expect(queryFn).toHaveBeenCalledTimes(2)
		unsubscribe()
	})

	it("newEvent is a no-op when the events list was never opened (no phantom refetch)", () => {
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleGeneralEvent(generalEvt(newEvent()))

		expect(invalidate).not.toHaveBeenCalled()
		expect(performLogout).not.toHaveBeenCalled()
	})
})
