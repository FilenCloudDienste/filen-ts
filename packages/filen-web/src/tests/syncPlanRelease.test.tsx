// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import type { DesktopSyncPair, DesktopSyncPlanPage } from "@filen/shared/desktop"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// A dry run answering after the list or card that asked for it is gone (unmounted, or showing another key) is
// released, not held in the shell until it expires; a failed dry run read can be retried.

const { api } = vi.hoisted(() => ({
	api: {
		plan: vi.fn(),
		planPage: vi.fn(),
		releasePlan: vi.fn()
	}
}))

vi.mock("@/features/sync/lib/syncStore", () => ({ syncApi: () => api }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>
}))
vi.mock("@/features/sync/components/reviewCard", () => ({ ReviewCard: ({ actions }: { actions: ReactNode }) => <>{actions}</> }))
vi.mock("@/features/sync/components/pairHero", () => ({ PairHero: () => null }))
vi.mock("@/features/sync/components/noticeBanner", () => ({ HoldBanner: () => null, InfoNotices: () => null, NoticeBanner: () => null }))
vi.mock("@/features/sync/components/removePairDialog", () => ({ RemovePairDialog: () => null }))
vi.mock("@/features/sync/components/activityTab", () => ({ ActivityTab: () => null }))
vi.mock("@/features/sync/components/issuesTab", () => ({ IssuesTab: () => null }))
vi.mock("@/features/sync/components/ignoredTab", () => ({ IgnoredTab: () => null }))
vi.mock("@/features/sync/components/settingsTab", () => ({ SettingsTab: () => null }))

const { PlannedEntries } = await import("@/features/sync/components/plannedEntries")
const { SyncPairDetail } = await import("@/features/sync/components/syncPairDetail")

registerAllActions()

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const PLAN = { planId: "plan-1", summary: null }

function pendingPlan(): (value: unknown) => void {
	let answer: (value: unknown) => void = () => undefined

	api.plan.mockReturnValueOnce(
		new Promise(resolve => {
			answer = resolve
		})
	)
	api.releasePlan.mockResolvedValue(undefined)
	api.planPage.mockResolvedValue({ ok: true, value: { list: "actions", total: 0, entries: [] } })

	return value => {
		answer(value)
	}
}

function Planned({ readKey }: { readKey: string }) {
	return (
		<PlannedEntries
			pairId="pair-1"
			readKey={readKey}
			list="actions"
			pick={(page: DesktopSyncPlanPage) => (page.list === "actions" ? page.entries : [])}
		>
			{(_paged, planId) => <p>{planId}</p>}
		</PlannedEntries>
	)
}

describe("PlannedEntries", () => {
	it("releases a dry run that answers after the list unmounted", async () => {
		const answer = pendingPlan()
		const { unmount } = render(<Planned readKey="a" />)

		unmount()

		await act(async () => {
			answer({ ok: true, value: PLAN })
			await Promise.resolve()
		})

		expect(api.releasePlan).toHaveBeenCalledWith("plan-1")
	})

	it("releases a dry run that answers after the list moved to another key", async () => {
		const answer = pendingPlan()

		api.plan.mockReturnValueOnce(new Promise(() => undefined))

		const { rerender } = render(<Planned readKey="a" />)

		rerender(<Planned readKey="b" />)

		await act(async () => {
			answer({ ok: true, value: PLAN })
			await Promise.resolve()
		})

		expect(api.releasePlan).toHaveBeenCalledWith("plan-1")
		expect(screen.queryByText("plan-1")).toBeNull()
	})

	it("keeps the dry run the list still shows", async () => {
		const answer = pendingPlan()

		render(<Planned readKey="a" />)

		await act(async () => {
			answer({ ok: true, value: PLAN })
			await Promise.resolve()
		})

		expect(await screen.findByText("plan-1")).toBeTruthy()
		expect(api.releasePlan).not.toHaveBeenCalled()
	})

	it("retries a failed dry run read", async () => {
		api.plan.mockResolvedValueOnce({ ok: false, error: { code: "timeout" } })
		api.plan.mockResolvedValueOnce({ ok: true, value: PLAN })
		api.planPage.mockResolvedValue({ ok: true, value: { list: "actions", total: 0, entries: [] } })
		api.releasePlan.mockResolvedValue(undefined)

		render(<Planned readKey="a" />)

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(await screen.findByText("plan-1")).toBeTruthy()
		expect(api.plan).toHaveBeenCalledTimes(2)
	})
})

const PAIR: DesktopSyncPair = {
	id: "pair-1",
	name: "Projects",
	localRoot: "/Users/a/Projects",
	remoteRoot: "remote-uuid",
	mode: "twoWay",
	paused: true,
	phase: "idle",
	progress: null,
	transfers: [],
	lastSyncedAt: null,
	lastError: null,
	issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, skippedSymlinks: 0, failed: 0 },
	degraded: { local: false, remote: false },
	stage: null,
	halted: null,
	refused: null,
	review: {
		reason: "migrated",
		findings: [],
		summary: {
			actions: 3,
			uploadBytes: 0,
			downloadBytes: 0,
			heldDeletions: 0,
			heldReason: null,
			conflicts: 0,
			unsyncable: 0,
			skippedSymlinks: 0,
			ignored: 0,
			refused: null
		}
	},
	notices: [],
	rootProblem: null,
	holds: [],
	info: []
}

describe("review card", () => {
	it("releases a dry run that answers after the card unmounted", async () => {
		const answer = pendingPlan()
		const { unmount } = render(
			<SyncPairDetail
				pair={PAIR}
				tab="settings"
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Show changes" }))

		expect(api.plan).toHaveBeenCalledWith("pair-1")

		unmount()

		await act(async () => {
			answer({ ok: true, value: PLAN })
			await Promise.resolve()
		})

		expect(api.releasePlan).toHaveBeenCalledWith("plan-1")
	})
})
