// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// A sync read that failed once (host restarting, a timeout) offers "Try again", which reads again.

const { api, store } = vi.hoisted(() => ({
	api: {
		heldDeletions: vi.fn(),
		userIgnore: vi.fn()
	},
	store: {
		overview: {
			pairs: [
				{
					id: "pair-1",
					issues: { conflicts: 0, heldDeletions: 2, unsyncable: 0, skippedSymlinks: 0, failed: 0 },
					lastError: null,
					halted: null,
					refused: null,
					paused: false,
					lastSyncedAt: null
				}
			]
		}
	}
}))

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => api,
	useSyncStore: (select: (state: typeof store) => unknown) => select(store)
}))

const { IssuesTab } = await import("@/features/sync/components/issuesTab")
const { UserIgnoreEditor } = await import("@/features/sync/components/userIgnoreEditor")

registerAllActions()

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("sync read retry", () => {
	it("held deletions", async () => {
		api.heldDeletions.mockResolvedValueOnce({ ok: false, error: { code: "timeout" } })
		api.heldDeletions.mockResolvedValueOnce({
			ok: true,
			value: { passToken: "token", reason: null, total: 1, entries: [], gaps: [], gapsTotal: 0 }
		})

		render(<IssuesTab pairId="pair-1" />)

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(api.heldDeletions).toHaveBeenCalledTimes(2)
		await vi.waitFor(() => {
			expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
		})
	})

	it("ignore rules", async () => {
		api.userIgnore.mockResolvedValueOnce({ ok: false, error: { code: "hostUnavailable" } })
		api.userIgnore.mockResolvedValueOnce({ ok: true, value: { text: "*.tmp", defaults: [] } })

		render(<UserIgnoreEditor />)

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(api.userIgnore).toHaveBeenCalledTimes(2)
		expect(await screen.findByDisplayValue("*.tmp")).toBeTruthy()
	})
})
