// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { CopyFailure, CopyReport, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { pauseCopy, resumeCopy, copyItemsTo } = vi.hoisted(() => ({
	pauseCopy: vi.fn(),
	resumeCopy: vi.fn(),
	copyItemsTo: vi.fn<() => Promise<CopyReport>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { pauseCopy, resumeCopy, copyItemsTo } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { CopyJobToast } from "@/features/transfers/components/copyJobToast"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function seed(overrides: Partial<CopyJob> = {}): void {
	const job: CopyJob = { ...createCopyJob("job", { uuid: null, name: "Photos" }, 3), cardVisible: true, ...overrides }

	useCopyJobsStore.setState({ jobs: { job }, cancelPromptId: null })
	useTransfersStore.setState({
		transfers: [
			{
				id: "job",
				direction: "copy",
				name: "3 items",
				size: job.totals.bytes,
				bytesTransferred: job.counts.bytesDone,
				status: job.outcome.status === "running" ? "copying" : "done",
				paused: false,
				parentUuid: null,
				startedAt: 0
			}
		],
		speedSamples: []
	})
}

const COPYING: Partial<CopyJob> = {
	phase: "copyingFiles",
	totals: { dirs: 1, files: 40, bytes: 4_000_000 },
	counts: { ...createCopyJob("x", { uuid: null, name: "" }, 1).counts, filesDone: 12, bytesDone: 1_000_000 },
	bytesPerSecond: 500_000,
	etaMs: 6_000
}

function failure(label: string): CopyFailure {
	return {
		item: {
			uuid: testUuid(label),
			stableUUID: undefined,
			parent: testUuid("root"),
			size: 1n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 0n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: { name: label, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
		},
		info: {
			sourceUuid: testUuid(label),
			sourcePath: `dir/${label}`,
			destParent: testUuid("root"),
			destParentDir: { uuid: testUuid("root") },
			destName: label,
			stage: "upload",
			error: { kind: "Server", message: "m", serverMessage: "Upload rejected", serverCode: undefined },
			affectedFiles: 1n,
			affectedBytes: 1n,
			existingFile: undefined
		}
	}
}

function renderCard() {
	const onDismiss = vi.fn()
	const onHeightChange = vi.fn()
	const onRetried = vi.fn<(retryJobId: string) => void>()

	render(
		<CopyJobToast
			jobId="job"
			onDismiss={onDismiss}
			onHeightChange={onHeightChange}
			onRetried={onRetried}
		/>
	)

	return { onDismiss, onHeightChange, onRetried }
}

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn()
			disconnect = vi.fn()
		}
	)
})

afterEach(() => {
	cleanup()
})

describe("CopyJobToast", () => {
	it("renders nothing for a job that is gone", () => {
		useCopyJobsStore.setState({ jobs: {}, cancelPromptId: null })

		const { container } = render(
			<CopyJobToast
				jobId="job"
				onDismiss={vi.fn()}
				onHeightChange={vi.fn()}
				onRetried={vi.fn()}
			/>
		)

		expect(container.innerHTML).toBe("")
	})

	it("shows the compact running card: title, files, percent, bytes, speed, time left and the tab note", () => {
		seed(COPYING)
		renderCard()

		expect(screen.getByText("Copying 3 items → Photos")).toBeTruthy()
		expect(screen.getByText("12 of 40 files")).toBeTruthy()
		expect(screen.getByText("25%")).toBeTruthy()
		expect(screen.getByText(/^\S+ \S+ of \S+ \S+ · \S+ \S+\/s · 0:06 left$/)).toBeTruthy()
		expect(screen.getByText("Closing this tab stops the copy.")).toBeTruthy()
		expect(screen.getByRole("progressbar", { name: "Copy progress" })).toBeTruthy()
	})

	it("hides through its dismiss button", () => {
		seed(COPYING)

		const { onDismiss } = renderCard()

		fireEvent.click(screen.getByRole("button", { name: "Hide copy progress" }))

		expect(onDismiss).toHaveBeenCalledTimes(1)
	})

	it("pauses and resumes through the transfer controls", () => {
		seed(COPYING)
		renderCard()

		fireEvent.click(screen.getByRole("button", { name: "Pause" }))

		expect(pauseCopy).toHaveBeenCalledWith("job")

		fireEvent.click(screen.getByRole("button", { name: "Resume" }))

		expect(resumeCopy).toHaveBeenCalledWith("job")
	})

	it("opens the stop prompt for this job", () => {
		seed(COPYING)
		renderCard()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(useCopyJobsStore.getState().cancelPromptId).toBe("job")
	})

	it("expands details with the files in flight", () => {
		seed({ ...COPYING, active: [{ destUuid: "d", name: "holiday.jpg", size: 2_048, bytesDone: 1_024 }] })
		renderCard()

		const toggle = screen.getByRole("button", { name: "Details" })

		expect(toggle.getAttribute("aria-expanded")).toBe("false")

		fireEvent.click(toggle)

		expect(toggle.getAttribute("aria-expanded")).toBe("true")
		expect(screen.getByText("Copying now")).toBeTruthy()
		expect(screen.getByText("holiday.jpg")).toBeTruthy()
	})

	it("says so when there is nothing to detail yet", () => {
		seed(COPYING)
		renderCard()

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("Nothing to report yet.")).toBeTruthy()
	})

	it("offers a retry of the failures once settled, which supersedes this card", () => {
		const failed = [failure("a.txt"), failure("b.txt")]

		seed({
			...COPYING,
			outcome: { status: "doneWithFailures" },
			retryable: failed,
			failures: failed.map(f => ({
				sourceUuid: f.info.sourceUuid,
				sourcePath: f.info.sourcePath,
				destName: f.info.destName,
				error: { species: "sdk" as const, kind: "Server", message: "m", label: "Upload rejected" },
				affectedFiles: 1,
				affectedBytes: 1
			})),
			renamedCount: 1
		})
		copyItemsTo.mockReturnValue(new Promise(() => undefined))

		const { onRetried } = renderCard()

		expect(screen.getByText("Copy to Photos")).toBeTruthy()
		expect(screen.getByText("2 items couldn't be copied")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
		expect(screen.queryByText("Closing this tab stops the copy.")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("dir/a.txt")).toBeTruthy()
		expect(screen.getAllByText("Upload rejected")).toHaveLength(2)
		expect(screen.getByText("1 item got a new name because its name was taken or not allowed.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Retry failed" }))

		expect(copyItemsTo).toHaveBeenCalledTimes(1)
		expect(onRetried).toHaveBeenCalledTimes(1)
		expect(onRetried.mock.calls[0]?.[0]).not.toBe("job")
	})

	it("shows a finished copy as complete", () => {
		seed({ ...COPYING, outcome: { status: "done" } })
		renderCard()

		expect(screen.getByText("Copied 3 items → Photos")).toBeTruthy()
		expect(screen.getByText("Done")).toBeTruthy()
		expect(screen.getByText("100%")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
	})
})
