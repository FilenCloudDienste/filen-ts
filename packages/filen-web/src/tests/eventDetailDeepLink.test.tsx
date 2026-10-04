// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { UserEvent } from "@filen/sdk-rs"
import "@/lib/i18n"

const { getUserEvent, online } = vi.hoisted(() => ({
	getUserEvent: vi.fn<(uuid: string) => Promise<UserEvent>>(),
	online: { value: true }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserEvent } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({
	persister: { persistQuery: vi.fn() },
	noDiskPersister: <T,>(queryFn: (context: unknown) => T, context: unknown) => queryFn(context)
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.value }))

import { queryClient } from "@/queries/client"
import { EventDetailDialog } from "@/features/settings/components/events/eventDetailDialog"
import { testUuid } from "@/tests/support/uuid"

const UUID = testUuid("evt")

function renderDeepLink(waitForList = false) {
	const view = (wait: boolean) => (
		<QueryClientProvider client={queryClient}>
			<EventDetailDialog
				eventUuid={UUID}
				entry={null}
				waitForList={wait}
				onClose={() => undefined}
			/>
		</QueryClientProvider>
	)
	const result = render(view(waitForList))

	return {
		rerender: (wait: boolean) => {
			result.rerender(view(wait))
		}
	}
}

afterEach(() => {
	cleanup()
	queryClient.clear()
	getUserEvent.mockReset()
	online.value = true
})

describe("EventDetailDialog deep link", () => {
	it("waits for the list's first page before reading the event alone", async () => {
		getUserEvent.mockReturnValue(new Promise(() => undefined))

		const { rerender } = renderDeepLink(true)

		expect(getUserEvent).not.toHaveBeenCalled()

		rerender(false)

		await waitFor(() => {
			expect(getUserEvent).toHaveBeenCalledTimes(1)
		})
	})

	it("offers a retry when the read failed, rather than calling the event gone", async () => {
		getUserEvent.mockRejectedValue({ species: "sdk", kind: "Reqwest", label: "connection reset", message: "connection reset" })
		renderDeepLink()

		const retry = await screen.findByRole("button", { name: "Try again" })

		expect(screen.getByText("Couldn't load this event")).toBeTruthy()

		fireEvent.click(retry)

		await waitFor(() => {
			expect(getUserEvent).toHaveBeenCalledTimes(2)
		})
	})

	it("says the event is gone when the server has none", async () => {
		getUserEvent.mockRejectedValue({ species: "sdk", kind: "Server", label: "not found", message: "not found" })
		renderDeepLink()

		expect(await screen.findByText("This event couldn't be found. Events are kept for 30 days.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
	})

	it("says it is offline instead of spinning", () => {
		online.value = false
		renderDeepLink()

		expect(screen.getByText("You're offline. This event loads once you're back online.")).toBeTruthy()
	})
})
