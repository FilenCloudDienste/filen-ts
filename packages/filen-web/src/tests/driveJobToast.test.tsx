// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { CopyFailureDTO, CopyReportDTO } from "@/lib/sdk/jobErrors"
import "@/lib/i18n"

const { pauseTransfer, resumeTransfer, copyItemsTo, rerunCompress, retryFailedExtract } = vi.hoisted(() => ({
	pauseTransfer: vi.fn(),
	resumeTransfer: vi.fn(),
	copyItemsTo: vi.fn<() => Promise<CopyReportDTO>>(),
	rerunCompress: vi.fn<(jobId: string) => string | null>(),
	retryFailedExtract: vi.fn<(jobId: string) => string | null>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { pauseTransfer, resumeTransfer, copyItemsTo } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/drive/lib/archiveJobs", () => ({ rerunCompress, retryFailedExtract }))

import { DriveJobToast } from "@/features/transfers/components/driveJobToast"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { testUuid } from "@/tests/support/uuid"
import { sdkErrorDTO } from "@/tests/support/sdkError"
import { ARCHIVE_ITEM, compressJob, extractFailure, extractJob } from "@/tests/support/archiveJobFixtures"

function seed(overrides: Partial<CopyJob> = {}): void {
	seedJob({ ...createCopyJob("job", { uuid: null, name: "Photos" }, 3), cardVisible: true, ...overrides })
}

function seedJob(job: DriveJob, others: DriveJob[] = []): void {
	useDriveJobsStore.setState({
		jobs: Object.fromEntries([job, ...others].map(entry => [entry.id, entry])),
		cancelPromptId: null,
		passwordPromptId: null,
		reportJobId: null
	})
	useTransfersStore.setState({
		transfers: [
			{
				id: job.id,
				direction: job.kind,
				name: "3 items",
				size: 0,
				bytesTransferred: 0,
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

function failure(label: string): CopyFailureDTO {
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
			error: sdkErrorDTO("Server", 'Error of kind Server: error: API Error, message: `Some("Upload rejected")`', {
				serverMessage: "Upload rejected",
				innerMessage: 'error: API Error, message: `Some("Upload rejected")`'
			}),
			affectedFiles: 1n,
			affectedBytes: 1n
		}
	}
}

function renderCard() {
	const onDismiss = vi.fn()
	const onHeightChange = vi.fn()
	const onRetried = vi.fn<(retryJobId: string) => void>()
	const onShowDirectory = vi.fn()

	render(
		<DriveJobToast
			jobId="job"
			onDismiss={onDismiss}
			onHeightChange={onHeightChange}
			onRetried={onRetried}
			onShowDirectory={onShowDirectory}
		/>
	)

	return { onDismiss, onHeightChange, onRetried, onShowDirectory }
}

afterEach(() => {
	cleanup()
})

describe("DriveJobToast for a copy", () => {
	it("renders nothing for a job that is gone", () => {
		useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null })

		const { container } = render(
			<DriveJobToast
				jobId="job"
				onDismiss={vi.fn()}
				onHeightChange={vi.fn()}
				onRetried={vi.fn()}
				onShowDirectory={vi.fn()}
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

		expect(pauseTransfer).toHaveBeenCalledWith("job")

		fireEvent.click(screen.getByRole("button", { name: "Resume" }))

		expect(resumeTransfer).toHaveBeenCalledWith("job")
	})

	it("opens the stop prompt for this job", () => {
		seed(COPYING)
		renderCard()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(useDriveJobsStore.getState().cancelPromptId).toBe("job")
	})

	// Sonner hands focus back to what held it before the toaster once focus leaves the toaster, which would
	// pull it out of the dialog: the card lets go before the dialog opens.
	it("lets go of the focus before opening the stop prompt", () => {
		seed(COPYING)
		renderCard()

		const cancel = screen.getByRole("button", { name: "Cancel" })
		const blurred = vi.fn()

		cancel.focus()
		cancel.addEventListener("blur", () => {
			blurred(useDriveJobsStore.getState().cancelPromptId)
		})
		fireEvent.click(cancel)

		expect(blurred).toHaveBeenCalledWith(null)
		expect(document.activeElement).not.toBe(cancel)
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
				error: f.info.error
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

		network.info.error = sdkErrorDTO(
			"Reqwest",
			"Error of kind Reqwest: error: error sending request for url (https://gateway.filen.io/v3/upload)",
			{ innerMessage: "error: error sending request for url (https://gateway.filen.io/v3/upload)" }
		)
		unknown.info.error = sdkErrorDTO("Walk", "Error of kind Walk: error: walk failed", { innerMessage: "error: walk failed" })

		const failed = [network, unknown, refused]

		seed({
			...COPYING,
			outcome: { status: "doneWithFailures" },
			failures: failed.map(f => ({
				sourceUuid: f.info.sourceUuid,
				sourcePath: f.info.sourcePath,
				destName: f.info.destName,
				error: f.info.error
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
				error: sdkErrorDTO(
					"MaxStorageReached",
					"Error of kind MaxStorageReached: error: Error of kind MaxStorageReached: error: API Error",
					{
						innerMessage: "error: Error of kind MaxStorageReached: error: API Error"
					}
				)
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
					error: failed.info.error
				}
			]
		})
		renderCard()
		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("dir/a.txt")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull()

		act(() => {
			useDriveJobsStore.getState().update("copy", "job", job => ({ ...job, created: [], trashResult: { moved: 1, failed: 0 } }))
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
				error: sdkErrorDTO("Reqwest", "Error of kind Reqwest: error: offline", { innerMessage: "error: offline" })
			},
			cancelRequest: "trash",
			trashResult: { moved: 3, failed: 0 }
		})
		renderCard()

		expect(screen.getByText("Network error. Please check your connection and try again.")).toBeTruthy()
		expect(screen.getByText("3 copied items were moved to the trash.")).toBeTruthy()
	})
})

describe("DriveJobToast for an archive job", () => {
	const error = sdkErrorDTO("Server", "Error of kind Server: error: API Error", { serverMessage: "Upload rejected" })

	it("shows a running compress with its own labels", () => {
		seedJob(
			compressJob({
				phase: "compressing",
				totals: { dirs: 0, files: 40, bytes: 4_000_000 },
				counts: { ...compressJob().counts, filesDone: 12, bytesRead: 1_000_000 }
			})
		)
		renderCard()

		expect(screen.getByText("Compressing 3 items into photos.zip")).toBeTruthy()
		expect(screen.getByText("12 of 40 files")).toBeTruthy()
		expect(screen.getByText("25%")).toBeTruthy()
		expect(screen.getByText("Closing this tab stops compressing.")).toBeTruthy()
		expect(screen.getByRole("progressbar", { name: "Compress progress" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Hide compress progress" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(useDriveJobsStore.getState().cancelPromptId).toBe("job")
	})

	it("warns that a paused job holds the slot another job waits for", () => {
		seedJob(compressJob({ phase: "compressing", paused: true }), [extractJob({}, "queued")])
		renderCard()

		expect(
			screen.getByText("This paused job holds the only archive slot. Other archive jobs wait until it resumes or stops.")
		).toBeTruthy()
	})

	it("doesn't warn about the slot while nothing waits for it", () => {
		seedJob(compressJob({ phase: "compressing", paused: true }))
		renderCard()

		expect(screen.queryByText(/holds the only archive slot/)).toBeNull()
	})

	it("asks for a password through the prompt", () => {
		seedJob(extractJob({ outcome: { status: "wrongPassword" } }))
		renderCard()

		expect(screen.getByText("The password is wrong.").className).toContain("text-destructive")

		fireEvent.click(screen.getByRole("button", { name: "Enter password" }))

		expect(useDriveJobsStore.getState().passwordPromptId).toBe("job")
	})

	it("sums up a finished extract, warns about misleading names and opens its report and directory", () => {
		const directory = narrowItem({
			uuid: testUuid("photos"),
			parent: testUuid("root"),
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "photos" } }
		})

		seedJob(
			extractJob({
				outcome: { status: "doneWithIssues" },
				counts: { ...extractJob().counts, filesDone: 7 },
				failures: { items: [extractFailure("dir/a.txt", 1, error)], omitted: 0 },
				misleadingNames: { items: [{ entry: { archive: "a", index: 2 }, path: "x" }], omitted: 1 },
				firstCreated: directory
			})
		)
		retryFailedExtract.mockReturnValue("retry")

		const { onShowDirectory, onRetried } = renderCard()

		expect(screen.getByText("Extract photos.zip → Photos")).toBeTruthy()
		expect(screen.getByText("1 item couldn't be extracted")).toBeTruthy()
		expect(screen.getByText("7 extracted · 0 skipped · 1 failed")).toBeTruthy()
		expect(
			screen.getByText(
				"2 extracted names hold hidden characters that can make them look like something else. Check them before opening."
			)
		).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "View report" }))

		expect(useDriveJobsStore.getState().reportJobId).toBe("job")

		fireEvent.click(screen.getByRole("button", { name: "Show in directory" }))

		expect(onShowDirectory).toHaveBeenCalledExactlyOnceWith(directory)

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("Couldn't extract")).toBeTruthy()
		expect(screen.getByText("dir/a.txt")).toBeTruthy()
		// Beside the other result actions, once.
		expect(screen.getAllByRole("button", { name: "Retry failed" })).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Details" }))
		fireEvent.click(screen.getByRole("button", { name: "Retry failed" }))

		expect(retryFailedExtract).toHaveBeenCalledWith("job")
		expect(onRetried).toHaveBeenCalledExactlyOnceWith("retry")
	})

	it("reruns a compress that didn't fit, even with an unknown needed size", () => {
		seedJob(compressJob({ outcome: { status: "quotaExceeded", neededBytes: null, freeBytes: 0 } }))
		rerunCompress.mockReturnValue("rerun")

		const { onRetried } = renderCard()

		expect(screen.getByText(/^There isn't enough free storage\. Only \S+ \S+ is free\.$/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(rerunCompress).toHaveBeenCalledWith("job")
		expect(onRetried).toHaveBeenCalledExactlyOnceWith("rerun")
	})

	it("shows a saved archive and the notes of a stop that came after it", () => {
		seedJob(compressJob({ outcome: { status: "done" }, cancelRequest: "keep", stoppedAfterArchive: true, archive: ARCHIVE_ITEM }))

		const { onShowDirectory } = renderCard()

		expect(screen.getByText("Compressed 3 items into photos.zip")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Details" }))

		expect(screen.getByText("The archive was already saved when the job stopped, so it was kept.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Show in directory" }))

		expect(onShowDirectory).toHaveBeenCalledExactlyOnceWith(ARCHIVE_ITEM)
	})
})
