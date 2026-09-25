// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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
import { copyErrorDTO, createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { narrowItem } from "@/features/drive/lib/item"
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
			stage: { type: "upload" },
			error: {
				kind: "Server",
				message: 'Error of kind Server: error: API Error, message: `Some("Upload rejected")`',
				serverMessage: "Upload rejected",
				serverCode: undefined,
				innerMessage: 'error: API Error, message: `Some("Upload rejected")`'
			},
			affectedFiles: 1n,
			affectedBytes: 1n
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
				error: copyErrorDTO(f.info.error),
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

	// The SDK's message is developer text, in English whatever the language.
	it("words an item's error by its kind, then the server's message, never the SDK's own message", () => {
		const network = failure("network.txt")
		const unknown = failure("unknown.txt")
		const refused = failure("refused.txt")

		network.info.error = {
			kind: "Reqwest",
			message: "Error of kind Reqwest: error: error sending request for url (https://gateway.filen.io/v3/upload)",
			serverMessage: undefined,
			serverCode: undefined,
			innerMessage: "error: error sending request for url (https://gateway.filen.io/v3/upload)"
		}
		unknown.info.error = {
			kind: "Walk",
			message: "Error of kind Walk: error: walk failed",
			serverMessage: undefined,
			serverCode: undefined,
			innerMessage: "error: walk failed"
		}

		const failed = [network, unknown, refused]

		seed({
			...COPYING,
			outcome: { status: "doneWithFailures" },
			failures: failed.map(f => ({
				sourceUuid: f.info.sourceUuid,
				sourcePath: f.info.sourcePath,
				destName: f.info.destName,
				error: copyErrorDTO(f.info.error),
				affectedFiles: 1,
				affectedBytes: 1
			}))
		})
		renderCard()
		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("Network error. Please check your connection and try again.")).toBeTruthy()
		expect(screen.getByText("Something went wrong.")).toBeTruthy()
		expect(screen.getByText("Upload rejected")).toBeTruthy()
		expect(screen.queryByText(/Error of kind/)).toBeNull()
		// The inner message is developer text too.
		expect(screen.queryByText("error: walk failed")).toBeNull()
	})

	it("words a failed copy's error by its kind", () => {
		seed({
			...COPYING,
			outcome: {
				status: "failed",
				error: copyErrorDTO({
					kind: "MaxStorageReached",
					message: "Error of kind MaxStorageReached: error: Error of kind MaxStorageReached: error: API Error",
					serverMessage: undefined,
					serverCode: undefined,
					innerMessage: "error: Error of kind MaxStorageReached: error: API Error"
				})
			}
		})
		renderCard()

		expect(screen.getByText("You have reached your maximum storage capacity.")).toBeTruthy()
		expect(screen.queryByText(/Error of kind/)).toBeNull()
	})

	it("says the copies are moving to the trash while a stop that asked for it finishes", () => {
		seed({
			...COPYING,
			outcome: { status: "cancelled" },
			cancelRequest: "trash",
			created: [
				narrowItem({
					uuid: testUuid("copied"),
					parent: testUuid("root"),
					color: "default",
					timestamp: 0n,
					favorited: false,
					meta: { type: "decoded", data: { name: "copied" } }
				})
			]
		})
		renderCard()

		expect(screen.getByText("Moving copied items to the trash…")).toBeTruthy()
	})

	it("offers no retry of the failures until the copies a stop asked to trash are there", () => {
		const failed = failure("a.txt")

		seed({
			...COPYING,
			outcome: { status: "cancelled" },
			cancelRequest: "trash",
			created: [
				narrowItem({
					uuid: testUuid("copied"),
					parent: testUuid("root"),
					color: "default",
					timestamp: 0n,
					favorited: false,
					meta: { type: "decoded", data: { name: "copied" } }
				})
			],
			retryable: [failed],
			failures: [
				{
					sourceUuid: failed.info.sourceUuid,
					sourcePath: failed.info.sourcePath,
					destName: failed.info.destName,
					error: copyErrorDTO(failed.info.error),
					affectedFiles: 1,
					affectedBytes: 1
				}
			]
		})
		renderCard()
		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("dir/a.txt")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull()

		act(() => {
			useCopyJobsStore.getState().update("job", job => ({ ...job, created: [], trashResult: { moved: 1, failed: 0 } }))
		})

		expect(screen.getByRole("button", { name: "Retry failed" })).toBeTruthy()
	})

	it("shows a finished copy as complete", () => {
		seed({ ...COPYING, outcome: { status: "done" } })
		renderCard()

		expect(screen.getByText("Copied 3 items → Photos")).toBeTruthy()
		expect(screen.getByText("Done")).toBeTruthy()
		expect(screen.getByText("100%")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
	})

	// The stop reached it only after the copy had finished; what it copied went to the trash all the same.
	it("shows a finished copy whose stop moved its copies to the trash as undone, not complete", () => {
		seed({ ...COPYING, outcome: { status: "done" }, cancelRequest: "trash", trashResult: { moved: 2, failed: 1 } })
		renderCard()

		expect(screen.getByText("Copy to Photos")).toBeTruthy()
		expect(screen.getByText("Some copied items couldn't be moved to the trash.")).toBeTruthy()
		expect(screen.queryByText("Copied 3 items → Photos")).toBeNull()
		expect(screen.queryByText("Done")).toBeNull()
	})

	it("tells what the trash did after a failed copy's error", () => {
		seed({
			...COPYING,
			outcome: {
				status: "failed",
				error: copyErrorDTO({
					kind: "Reqwest",
					message: "Error of kind Reqwest: error: offline",
					serverMessage: undefined,
					serverCode: undefined,
					innerMessage: "error: offline"
				})
			},
			cancelRequest: "trash",
			trashResult: { moved: 3, failed: 0 }
		})
		renderCard()

		expect(screen.getByText("Network error. Please check your connection and try again.")).toBeTruthy()
		expect(screen.getByText("3 copied items were moved to the trash.")).toBeTruthy()
	})
})
