// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DesktopSyncPlan, DesktopSyncPlanSummary, DesktopSyncResult } from "@filen/shared/desktop"
import "@/lib/i18n"
import { ReviewCard, ReviewSummary } from "@/features/sync/components/reviewCard"
import { PlannedEntries } from "@/features/sync/components/plannedEntries"
import { PagedFooter } from "@/features/sync/components/syncEntryRows"

// A page of a plan, or the shell's answer for a plan it released (planExpired) when the id is listed in `expired`.
const expired = new Set<string>()
const planPage = vi.fn((planId: string, list: string) =>
	Promise.resolve(
		expired.has(planId)
			? { ok: false, error: { code: "planExpired" } }
			: { ok: true, value: { list, total: 1, entries: [{ relPath: `${planId}.txt`, kind: "upload", size: 1 }] } }
	)
)
const plan = vi.fn((_pairId: string): Promise<DesktopSyncResult<DesktopSyncPlan | null>> => Promise.resolve({ ok: true, value: null }))
const releasePlan = vi.fn((_planId: string) => Promise.resolve())

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => ({ planPage, plan, releasePlan })
}))

const SUMMARY: DesktopSyncPlanSummary = {
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

afterEach(() => {
	cleanup()
	planPage.mockClear()
	plan.mockReset()
	releasePlan.mockClear()
	expired.clear()
})

describe("ReviewCard", () => {
	it("shows the lists once the plan is read, without a second click", () => {
		render(
			<ReviewCard
				title="Review"
				description="Check it"
				actions={null}
				summary={SUMMARY}
				findings={[]}
				planId="plan-1"
				listsOpen
			/>
		)

		expect(screen.getByRole("group", { name: "Planned changes" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Show changes" })).toBeNull()
		expect(planPage).toHaveBeenCalledWith("plan-1", "actions", 0, expect.any(Number))
	})

	it("reads nothing before there is a plan", () => {
		render(
			<ReviewCard
				title="Review"
				description="Check it"
				actions={null}
				summary={SUMMARY}
				findings={[]}
				planId={null}
				listsOpen
			/>
		)

		expect(screen.queryByRole("group", { name: "Planned changes" })).toBeNull()
		expect(planPage).not.toHaveBeenCalled()
	})
})

describe("ReviewSummary", () => {
	it("counts skipped symlinks apart from what can't be synced", () => {
		render(
			<ReviewSummary
				summary={{ ...SUMMARY, unsyncable: 1, skippedSymlinks: 2 }}
				findings={[]}
				planId="plan-1"
				listsOpen
			/>
		)

		expect(screen.getByText(/1 item can't be synced · 2 symlinks skipped/)).toBeTruthy()
		expect(screen.getByRole("button", { name: /Skipped symlinks/ })).toBeTruthy()
	})

	it("keeps the lists behind a click by default", () => {
		render(
			<ReviewSummary
				summary={SUMMARY}
				findings={[]}
				planId="plan-1"
			/>
		)

		expect(screen.queryByRole("group", { name: "Planned changes" })).toBeNull()
		expect(planPage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Show changes" }))

		expect(screen.getByRole("group", { name: "Planned changes" })).toBeTruthy()
		expect(planPage).toHaveBeenCalledOnce()
	})
})

describe("an expired dry run", () => {
	it("hands Try again to the plan's owner, and the list pages the new plan", async () => {
		expired.add("plan-1")

		const onPlanExpired = vi.fn()
		const { rerender } = render(
			<ReviewSummary
				summary={SUMMARY}
				findings={[]}
				planId="plan-1"
				listsOpen
				onPlanExpired={onPlanExpired}
			/>
		)

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(onPlanExpired).toHaveBeenCalledOnce()
		expect(planPage).toHaveBeenCalledTimes(1)

		rerender(
			<ReviewSummary
				summary={SUMMARY}
				findings={[]}
				planId="plan-2"
				listsOpen
				onPlanExpired={onPlanExpired}
			/>
		)

		await waitFor(() => {
			expect(planPage).toHaveBeenLastCalledWith("plan-2", "actions", 0, expect.any(Number))
		})
	})

	function plannedList() {
		render(
			<PlannedEntries
				pairId="pair"
				readKey="pair:actions"
				list="actions"
				pick={page => page.entries.map(entry => entry.relPath)}
			>
				{paged => (
					<>
						{paged.entries.map(path => (
							<p key={path}>{path}</p>
						))}
						<PagedFooter paged={paged} />
					</>
				)}
			</PlannedEntries>
		)
	}

	it("plans again from Try again in a planned list and pages the new id", async () => {
		expired.add("plan-1")
		plan.mockResolvedValueOnce({ ok: true, value: { planId: "plan-1", summary: SUMMARY } }).mockResolvedValueOnce({
			ok: true,
			value: { planId: "plan-2", summary: SUMMARY }
		})
		plannedList()

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(await screen.findByText("plan-2.txt")).toBeTruthy()
		expect(plan).toHaveBeenCalledTimes(2)
		expect(planPage.mock.calls.map(call => call[0])).toEqual(["plan-1", "plan-2"])
		// The expired id is let go once the new one shows.
		expect(releasePlan).toHaveBeenCalledWith("plan-1")
	})

	it("shows the not-yet-known state when planning again finds no dry run", async () => {
		expired.add("plan-1")
		plan.mockResolvedValueOnce({ ok: true, value: { planId: "plan-1", summary: SUMMARY } }).mockResolvedValueOnce({
			ok: true,
			value: null
		})
		plannedList()

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		expect(await screen.findByText(/still reading the cloud directory/)).toBeTruthy()
		expect(planPage).toHaveBeenCalledTimes(1)
	})
})
