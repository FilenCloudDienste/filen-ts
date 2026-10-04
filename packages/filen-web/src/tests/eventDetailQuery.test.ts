// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { UserEvent, UserEventResult } from "@filen/sdk-rs"

const { getUserEvent } = vi.hoisted(() => ({
	getUserEvent: vi.fn<(uuid: string) => Promise<UserEvent>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserEvent } }))

vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

vi.mock("@/queries/persist", () => ({
	persister: { persistQuery: vi.fn() },
	noDiskPersister: <T>(queryFn: (context: unknown) => T, context: unknown) => queryFn(context)
}))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { EVENTS_QUERY_KEY } from "@/features/settings/queries/events"
import { cachedEventEntry, useEventDetailQuery } from "@/features/settings/queries/eventDetail"
import { testUuid } from "@/tests/support/uuid"

const UUID = testUuid("evt")

function event(uuid = UUID): UserEvent {
	return { id: 7n, timestamp: 1_700_000_000_000n, uuid, kind: { type: "login", ip: "203.0.113.7", userAgent: "" } }
}

afterEach(() => {
	queryClient.clear()
	getUserEvent.mockReset()
})

describe("useEventDetailQuery", () => {
	it("reads a deep-linked event once, by its uuid", async () => {
		getUserEvent.mockResolvedValue(event())

		const { result } = renderHook(() => useEventDetailQuery(UUID), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})
		expect(result.current.data).toMatchObject({ type: "ok", key: "7", timestamp: 1_700_000_000_000n })
		expect(getUserEvent).toHaveBeenCalledTimes(1)
		expect(getUserEvent).toHaveBeenCalledWith(UUID)
	})

	it("reads nothing for an event the list already holds, undecodable ones included", () => {
		const raw: UserEventResult = {
			type: "err",
			message: "unknown variant",
			raw: JSON.stringify({ id: 9, uuid: testUuid("raw"), timestamp: 1_700_000_000, type: "new" })
		}

		queryClient.setQueryData<UserEventResult[]>(EVENTS_QUERY_KEY, [{ type: "ok", ...event() }, raw])

		const { result } = renderHook(() => useEventDetailQuery(UUID), { wrapper: queryClientWrapper(queryClient) })

		expect(result.current.data?.key).toBe("7")
		expect(cachedEventEntry(testUuid("raw"))?.type).toBe("unknown")
		expect(getUserEvent).not.toHaveBeenCalled()
	})

	it("fails for an event the server no longer has", async () => {
		getUserEvent.mockRejectedValue(new Error("not found"))

		const { result } = renderHook(() => useEventDetailQuery(UUID), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(result.current.status).toBe("error")
		})
	})
})
