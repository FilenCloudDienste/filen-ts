// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DesktopSyncPlanSummary } from "@filen/shared/desktop"
import "@/lib/i18n"
import { ReviewCard, ReviewSummary } from "@/features/sync/components/reviewCard"

const planPage = vi.fn((_planId: string, list: string) => Promise.resolve({ ok: true, value: { list, total: 0, entries: [] } }))

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => ({ planPage })
}))

const SUMMARY: DesktopSyncPlanSummary = {
	actions: 3,
	uploadBytes: 0,
	downloadBytes: 0,
	heldDeletions: 0,
	heldReason: null,
	conflicts: 0,
	unsyncable: 0,
	ignored: 0,
	refused: null
}

afterEach(() => {
	cleanup()
	planPage.mockClear()
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
