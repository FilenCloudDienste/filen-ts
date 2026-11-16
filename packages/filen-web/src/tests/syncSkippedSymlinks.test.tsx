// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DesktopSyncIssueCounts } from "@filen/shared/desktop"
import "@/lib/i18n"
import { IssuesTab } from "@/features/sync/components/issuesTab"
import { SkippedSymlinksSection } from "@/features/sync/components/skippedSymlinksSection"

const skippedSymlinks = vi.fn((_pairId: string, _offset: number, _limit: number) =>
	Promise.resolve({
		ok: true,
		value: {
			total: 2,
			entries: [
				{ relPath: "Projects/current", target: "Projects/2026" },
				{ relPath: "loop/self", target: "loop" }
			]
		}
	})
)

const NO_ISSUES: DesktopSyncIssueCounts = { conflicts: 0, heldDeletions: 0, unsyncable: 0, skippedSymlinks: 0, failed: 0 }

const store = {
	overview: {
		pairs: [
			{
				id: "7",
				issues: { ...NO_ISSUES, skippedSymlinks: 2 },
				lastError: null,
				halted: null,
				refused: null,
				paused: false,
				lastSyncedAt: 1
			}
		]
	}
}

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => ({ skippedSymlinks }),
	useSyncStore: (select: (state: typeof store) => unknown) => select(store)
}))

afterEach(() => {
	cleanup()
	skippedSymlinks.mockClear()
})

describe("SkippedSymlinksSection", () => {
	it("is collapsed by default and reads nothing until opened", () => {
		render(
			<SkippedSymlinksSection
				pairId="7"
				count={2}
				lastSyncedAt={1}
			/>
		)

		const toggle = screen.getByRole("button", { name: /Skipped symlinks \(2\)/ })

		expect(toggle.getAttribute("aria-expanded")).toBe("false")
		expect(screen.getByText("Synced once under their real path.")).toBeTruthy()
		expect(screen.queryByText("Projects/current")).toBeNull()
		expect(skippedSymlinks).not.toHaveBeenCalled()
	})

	it("lists each link with its target once opened, with no retry", async () => {
		render(
			<SkippedSymlinksSection
				pairId="7"
				count={2}
				lastSyncedAt={1}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: /Skipped symlinks \(2\)/ }))

		expect(await screen.findByText("→ Projects/2026")).toBeTruthy()
		expect(screen.getAllByTitle("Projects/current").length).toBeGreaterThan(0)
		expect(screen.getByText("→ loop")).toBeTruthy()
		expect(skippedSymlinks).toHaveBeenCalledExactlyOnceWith("7", 0, expect.any(Number))
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
		expect(screen.queryByRole("button", { name: /Retry all/ })).toBeNull()
	})
})

describe("IssuesTab", () => {
	it("shows a pair with only skipped symlinks as having no issues, the symlinks below", () => {
		render(<IssuesTab pairId="7" />)

		expect(screen.getByText("No issues")).toBeTruthy()
		expect(screen.queryByText("Can't be synced")).toBeNull()
		expect(screen.getByRole("button", { name: /Skipped symlinks \(2\)/ })).toBeTruthy()
	})
})
