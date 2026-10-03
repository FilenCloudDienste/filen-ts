// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@/lib/i18n"

const { retryFailedExtract, hideJobToast, showJobToast, navigate } = vi.hoisted(() => ({
	retryFailedExtract: vi.fn<(jobId: string) => string | null>(),
	hideJobToast: vi.fn(),
	showJobToast: vi.fn(),
	navigate: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/drive/lib/archiveJobs", () => ({ retryFailedExtract }))
vi.mock("@/features/transfers/lib/jobToast", () => ({ hideJobToast, showJobToast }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

import { JobReportDialog } from "@/features/transfers/components/jobReportDialog"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import type { ExtractSkipped } from "@filen/shared"
import { compressJob, extractFailure, extractJob } from "@/tests/support/archiveJobFixtures"

const ENTRY = { archive: "a", index: 0 }
const ERROR = { species: "plain" as const, message: "m", label: "l" }

function seed(job: DriveJob): void {
	useDriveJobsStore.setState({ jobs: { [job.id]: job }, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
}

function open(id = "job"): void {
	act(() => {
		useDriveJobsStore.getState().setReportJobId(id)
	})
}

// The virtualizer sizes its viewport off offsetHeight, which jsdom leaves at 0: a 384px list.
function mockListViewport(): void {
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("overflow-y-auto") && this.classList.contains("h-96") ? 384 : 0
		}
	})
	onTestFinished(() => {
		if (original === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", original)
		}
	})
}

function skipped(path: string, reason: ExtractSkipped["reason"]): ExtractSkipped {
	return { entry: ENTRY, path, pathTruncated: false, bytes: 0, reason }
}

beforeEach(() => {
	seed(extractJob({ outcome: { status: "done" } }))
})

afterEach(() => {
	cleanup()
})

describe("JobReportDialog", () => {
	it("stays closed, mounting no body, until a job with a report is asked for", () => {
		render(<JobReportDialog />)
		open()

		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("groups an extract's report by reason, macOS metadata collapsed and misleading names revealed", async () => {
		mockListViewport()
		seed(
			extractJob({
				outcome: { status: "doneWithIssues" },
				counts: { ...extractJob().counts, filesDone: 7 },
				skipped: {
					items: [
						skipped("link", { type: "symlink", target: "../etc/passwd" }),
						skipped("__MACOSX/._a", { type: "macMetadata" })
					],
					omitted: 0
				},
				misleadingNames: { items: [{ entry: ENTRY, path: "invoice‮fdp.exe" }], omitted: 0 }
			})
		)
		render(<JobReportDialog />)
		open()

		const dialog = await screen.findByRole("dialog")

		expect(dialog.textContent).toContain("7 extracted · 2 skipped · 0 failed")
		expect(dialog.textContent).toContain("Names with invisible or direction-changing characters")
		expect(dialog.textContent).toContain("Points to ../etc/passwd")
		expect(dialog.textContent).toContain("invoice⟨U+202E⟩fdp.exe")
		expect(dialog.textContent).not.toContain("__MACOSX/._a")

		fireEvent.click(within(dialog).getByRole("button", { name: /macOS metadata/ }))

		expect(dialog.textContent).toContain("__MACOSX/._a")
	})

	it("retries the failed entries from their heading as a new job whose card replaces this one's", async () => {
		mockListViewport()
		retryFailedExtract.mockReturnValue("retry")
		seed(
			extractJob({
				outcome: { status: "doneWithIssues" },
				failures: { items: [extractFailure("a.txt", 0, ERROR)], omitted: 0 }
			})
		)
		render(<JobReportDialog />)
		open()

		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Retry failed" }))

		expect(retryFailedExtract).toHaveBeenCalledWith("job")
		expect(useDriveJobsStore.getState().reportJobId).toBeNull()
		expect(hideJobToast).toHaveBeenCalledWith("job")
		expect(showJobToast).toHaveBeenCalledWith("retry")
	})

	it("offers no retry for failures that cannot go anywhere again", async () => {
		mockListViewport()
		seed(
			extractJob({
				outcome: { status: "doneWithIssues" },
				failures: { items: [{ ...extractFailure("a.txt", 0, ERROR), retry: null }], omitted: 0 }
			})
		)
		render(<JobReportDialog />)
		open()

		expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: "Retry failed" })).toBeNull()
	})

	it("renders only the lines in view of a report thousands of lines long", async () => {
		mockListViewport()
		seed(
			extractJob({
				outcome: { status: "doneWithIssues" },
				renamed: {
					items: Array.from({ length: 5000 }, (_, index) => ({
						entry: { archive: "a", index },
						path: `file-${String(index)}.txt`,
						name: `file-${String(index)} (1).txt`,
						reason: "duplicateName" as const
					})),
					omitted: 0
				}
			})
		)
		render(<JobReportDialog />)
		open()

		const dialog = await screen.findByRole("dialog")
		const rendered = within(dialog).getAllByText(/^Renamed to /).length

		// 384px of 44px rows, a heading, and 10 lines of overscan either side at most.
		expect(rendered).toBeGreaterThan(0)
		expect(rendered).toBeLessThanOrEqual(Math.ceil(384 / 44) + 10)
	})

	it("names a compress's originals, the uuid standing in for one it cannot name", async () => {
		mockListViewport()
		seed(
			compressJob({
				outcome: { status: "doneWithIssues" },
				dispositions: [
					{ uuid: "known", outcome: { type: "kept", reason: { type: "changed" }, bytesFreed: 0 } },
					{ uuid: "unknown-uuid", outcome: { type: "kept", reason: { type: "hasVersions" }, bytesFreed: 0 } }
				],
				sourceNames: { known: "Holiday.jpg" }
			})
		)
		render(<JobReportDialog />)
		open()

		const dialog = await screen.findByRole("dialog")

		expect(dialog.textContent).toContain("Holiday.jpg")
		expect(dialog.textContent).toContain("unknown-uuid")
		expect(dialog.textContent).toContain("It changed while the job ran")
	})

	it("closes when its job leaves the store, forgetting its id", async () => {
		mockListViewport()
		seed(extractJob({ outcome: { status: "doneWithIssues" }, failures: { items: [extractFailure("a", 0, ERROR)], omitted: 0 } }))
		render(<JobReportDialog />)
		open()
		await screen.findByRole("dialog")

		act(() => {
			useDriveJobsStore.getState().remove("job")
		})

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		// Its id goes too, so a job of the same id later does not reopen it.
		expect(useDriveJobsStore.getState().reportJobId).toBeNull()
	})
})
