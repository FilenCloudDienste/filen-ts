import { describe, expect, it } from "vitest"
import { cappedList, EMPTY_CAPPED_LIST, type ExtractSkipped } from "@filen/shared"
import {
	archiveCardDuration,
	archiveJobNotes,
	compressJobStatus,
	compressJobTitle,
	extractJobStatus,
	extractJobSummary,
	extractJobTitle
} from "@/features/transfers/components/archiveJobToast.logic"
import type { CompressJob } from "@/features/drive/lib/archiveJobs.logic"
import { compressJob, createdDirectory, extractFailure, extractJob } from "@/tests/support/archiveJobFixtures"

const ERROR = { species: "plain" as const, message: "offline", label: "offline" }

function skipped(index: number, reason: ExtractSkipped["reason"]): ExtractSkipped {
	return { entry: { archive: "a", index }, path: `p${String(index)}`, pathTruncated: false, bytes: 1, reason }
}

describe("archiveCardDuration", () => {
	it("stays while the job runs, a stop's trash is pending or a password is wanted", () => {
		expect(archiveCardDuration(compressJob())).toBe(Infinity)
		expect(archiveCardDuration(extractJob({ paused: true }))).toBe(Infinity)
		expect(
			archiveCardDuration(
				extractJob({ outcome: { status: "cancelled" }, cancelRequest: "trash", created: [createdDirectory("photos")] })
			)
		).toBe(Infinity)
		expect(archiveCardDuration(extractJob({ outcome: { status: "passwordRequired" } }))).toBe(Infinity)
		expect(archiveCardDuration(extractJob({ outcome: { status: "wrongPassword" } }))).toBe(Infinity)
	})

	it("times a clean finish short and anything to read longer", () => {
		expect(archiveCardDuration(compressJob({ outcome: { status: "done" } }))).toBe(4_000)
		expect(archiveCardDuration(extractJob({ outcome: { status: "done" } }))).toBe(4_000)
		expect(archiveCardDuration(compressJob({ outcome: { status: "doneWithIssues" } }))).toBe(8_000)
		expect(archiveCardDuration(compressJob({ outcome: { status: "done" }, cancelRequest: "keep", stoppedAfterArchive: true }))).toBe(
			8_000
		)
		expect(archiveCardDuration(extractJob({ outcome: { status: "cancelled" }, cancelRequest: "keep" }))).toBe(8_000)
		expect(archiveCardDuration(extractJob({ outcome: { status: "failed", error: ERROR } }))).toBe(8_000)
		// Names that read as something else are worth the time to read.
		expect(archiveCardDuration(extractJob({ outcome: { status: "done" }, misleadingNames: cappedList([], 2) }))).toBe(8_000)
	})
})

describe("compressJobTitle", () => {
	it("counts the items while compressing and once saved, and names only the archive otherwise", () => {
		expect(compressJobTitle(compressJob())).toEqual({
			key: "transfersCompressCardTitleRunning",
			values: { count: 3, name: "photos.zip" }
		})
		expect(compressJobTitle(compressJob({ outcome: { status: "done" } }))).toEqual({
			key: "transfersCompressCardTitleDone",
			values: { count: 3, name: "photos.zip" }
		})
		// The archive is saved, whatever else needs a look.
		expect(compressJobTitle(compressJob({ outcome: { status: "doneWithIssues" } })).key).toBe("transfersCompressCardTitleDone")
		expect(compressJobTitle(compressJob({ outcome: { status: "cancelled" } }))).toEqual({
			key: "transfersCompressCardTitleEnded",
			values: { name: "photos.zip" }
		})
	})

	it("names the archive as it was saved once it exists, the SDK's keep-both name included", () => {
		const archive = { data: { decryptedMeta: { name: "photos (1).zip" } } } as unknown as NonNullable<CompressJob["archive"]>

		expect(compressJobTitle(compressJob({ outcome: { status: "done" }, archive })).values.name).toBe("photos (1).zip")
		expect(compressJobTitle(compressJob({ outcome: { status: "cancelled" }, archive })).values.name).toBe("photos (1).zip")
	})
})

describe("extractJobTitle", () => {
	it("names the archive and its destination", () => {
		const values = { name: "photos.zip", destination: "Photos" }

		expect(extractJobTitle(extractJob())).toEqual({ key: "transfersExtractCardTitleExtracting", values })
		expect(extractJobTitle(extractJob({ outcome: { status: "done" } }))).toEqual({ key: "transfersExtractCardTitleExtracted", values })
		expect(extractJobTitle(extractJob({ outcome: { status: "doneWithIssues" } }))).toEqual({
			key: "transfersExtractCardTitleEnded",
			values
		})
		expect(extractJobTitle(extractJob({ outcome: { status: "wrongPassword" } }))).toEqual({
			key: "transfersExtractCardTitleEnded",
			values
		})
	})

	it("doesn't call an extract done once its stop asked to trash what it made", () => {
		expect(extractJobTitle(extractJob({ outcome: { status: "done" }, cancelRequest: "trash" })).key).toBe(
			"transfersExtractCardTitleEnded"
		)
	})
})

describe("compressJobStatus", () => {
	it("reads each phase while running", () => {
		expect(compressJobStatus(compressJob())).toEqual({ kind: "key", key: "transfersCopyPhaseScanning" })
		expect(compressJobStatus(compressJob({ scan: { sourcesDone: 1, sourcesTotal: 3 } }))).toEqual({
			kind: "listing",
			done: 1,
			count: 3
		})
		expect(compressJobStatus(compressJob({ phase: "waitingForWorker" }))).toEqual({ kind: "key", key: "transfersStatusWaitingForSlot" })
		expect(
			compressJobStatus(
				compressJob({
					phase: "compressing",
					totals: { dirs: 0, files: 40, bytes: 9 },
					counts: { ...compressJob().counts, filesDone: 12 }
				})
			)
		).toEqual({ kind: "files", done: 12, count: 40 })
		expect(compressJobStatus(compressJob({ phase: "finishing" }))).toEqual({ kind: "key", key: "transfersCopyPhaseFinishing" })
		expect(compressJobStatus(compressJob({ phase: "verifying" }))).toEqual({ kind: "key", key: "transfersCompressPhaseVerifying" })
		expect(compressJobStatus(compressJob({ phase: "disposingSources", dispose: "trash" }))).toEqual({
			kind: "key",
			key: "transfersArchivePhaseTrashingOriginals"
		})
		expect(compressJobStatus(compressJob({ phase: "disposingSources", dispose: "deletePermanently" }))).toEqual({
			kind: "key",
			key: "transfersArchivePhaseDeletingOriginals"
		})
	})

	it("lets stopping, paused and pausing override the phase, waiting included", () => {
		const waiting = compressJob({ phase: "waitingForWorker" })

		expect(compressJobStatus({ ...waiting, cancelRequest: "keep" })).toEqual({ kind: "key", key: "transfersCopyPhaseCancelling" })
		expect(compressJobStatus({ ...waiting, paused: true })).toEqual({ kind: "key", key: "transfersStatusPaused" })
		expect(compressJobStatus({ ...waiting, pausing: true })).toEqual({ kind: "key", key: "transfersCopyPhasePausing" })
	})

	it("says how a settled compress ended", () => {
		expect(compressJobStatus(compressJob({ outcome: { status: "done" } }))).toEqual({ kind: "key", key: "transfersStatusDone" })
		expect(compressJobStatus(compressJob({ outcome: { status: "doneWithIssues" } }))).toEqual({
			kind: "key",
			key: "transfersJobDoneWithIssues"
		})
		// The archive is saved, but the job ended with an error after it.
		expect(compressJobStatus(compressJob({ outcome: { status: "doneWithIssues" }, endError: ERROR }))).toEqual({
			kind: "error",
			error: ERROR
		})
		expect(compressJobStatus(compressJob({ outcome: { status: "cancelled" } }))).toEqual({
			kind: "key",
			key: "transfersCompressCancelled"
		})
		expect(compressJobStatus(compressJob({ outcome: { status: "failed", error: ERROR } }))).toEqual({ kind: "error", error: ERROR })
	})

	it("carries an unknown needed size of a refusal part way through", () => {
		expect(compressJobStatus(compressJob({ outcome: { status: "quotaExceeded", neededBytes: 9, freeBytes: 7 } }))).toEqual({
			kind: "quota",
			neededBytes: 9,
			freeBytes: 7
		})
		expect(compressJobStatus(compressJob({ outcome: { status: "quotaExceeded", neededBytes: null, freeBytes: 7 } }))).toEqual({
			kind: "quota",
			neededBytes: null,
			freeBytes: 7
		})
	})
})

describe("extractJobStatus", () => {
	it("reads each phase while running", () => {
		expect(extractJobStatus(extractJob())).toEqual({ kind: "key", key: "transfersStatusWaitingForSlot" })
		expect(extractJobStatus(extractJob({ phase: "scanning" }))).toEqual({ kind: "key", key: "transfersExtractPhaseScanning" })
		expect(extractJobStatus(extractJob({ phase: "extracting", counts: { ...extractJob().counts, filesDone: 5 } }))).toEqual({
			kind: "key",
			key: "transfersExtractFilesExtracted",
			count: 5
		})
		expect(extractJobStatus(extractJob({ phase: "finishing" }))).toEqual({ kind: "key", key: "transfersCopyPhaseFinishing" })
		expect(extractJobStatus(extractJob({ phase: "disposingSources", dispose: "trash" }))).toEqual({
			kind: "key",
			key: "transfersArchivePhaseTrashingOriginals"
		})
	})

	// A listing tells how many files are to come.
	it("counts the files against a planned total", () => {
		expect(
			extractJobStatus(
				extractJob({
					phase: "extracting",
					basis: { type: "planned", bytes: 100, files: 8 },
					counts: { ...extractJob().counts, filesDone: 5 }
				})
			)
		).toEqual({ kind: "files", done: 5, count: 8 })
	})

	it("asks for a password, telling a wrong one apart", () => {
		expect(extractJobStatus(extractJob({ outcome: { status: "passwordRequired" } }))).toEqual({ kind: "password", wrong: false })
		expect(extractJobStatus(extractJob({ outcome: { status: "wrongPassword" } }))).toEqual({ kind: "password", wrong: true })
	})

	it("counts the failed entries, or points at the details when only something else needs a look", () => {
		const failures = cappedList([extractFailure("a", 0, ERROR)], 2)

		expect(extractJobStatus(extractJob({ outcome: { status: "doneWithIssues" }, failures }))).toEqual({
			kind: "key",
			key: "transfersExtractFailedItems",
			count: 3
		})
		expect(extractJobStatus(extractJob({ outcome: { status: "doneWithIssues" } }))).toEqual({
			kind: "key",
			key: "transfersJobDoneWithIssues"
		})
	})

	it("tells a kept stop from a trashed one, and what the trash did after an end the stop came too late for", () => {
		expect(extractJobStatus(extractJob({ outcome: { status: "cancelled" } }))).toEqual({
			kind: "key",
			key: "transfersExtractCancelledKept"
		})
		expect(extractJobStatus(extractJob({ outcome: { status: "cancelled" }, trashResult: { moved: 2, failed: 0 } }))).toEqual({
			kind: "key",
			key: "transfersExtractCancelledTrashed",
			count: 2
		})
		expect(extractJobStatus(extractJob({ outcome: { status: "cancelled" }, trashResult: { moved: 1, failed: 1 } }))).toEqual({
			kind: "key",
			key: "transfersExtractCancelledTrashFailed"
		})
		expect(
			extractJobStatus(extractJob({ outcome: { status: "done" }, cancelRequest: "trash", trashResult: { moved: 3, failed: 0 } }))
		).toEqual({
			kind: "key",
			key: "transfersExtractTrashed",
			count: 3
		})
		expect(extractJobStatus(extractJob({ outcome: { status: "failed", error: ERROR }, trashResult: { moved: 1, failed: 1 } }))).toEqual(
			{
				kind: "error",
				error: ERROR,
				trash: { kind: "key", key: "transfersExtractTrashFailed" }
			}
		)
	})

	it("says the extracted items are moving to the trash until that settles", () => {
		expect(
			extractJobStatus(
				extractJob({ outcome: { status: "cancelled" }, cancelRequest: "trash", created: [createdDirectory("photos")] })
			)
		).toEqual({ kind: "key", key: "transfersExtractMovingToTrash" })
	})
})

describe("extractJobSummary", () => {
	it("sums up a settled extract that got anywhere", () => {
		const settled = extractJob({
			outcome: { status: "doneWithIssues" },
			counts: { ...extractJob().counts, filesDone: 12 },
			skipped: cappedList([skipped(0, { type: "macMetadata" })], 4),
			failures: cappedList([extractFailure("a", 1, ERROR)], 0)
		})

		expect(extractJobSummary(settled)).toEqual({ extracted: 12, skipped: 5, failed: 1 })
	})

	it("has nothing to sum up while running, after a password stop or when nothing happened", () => {
		expect(extractJobSummary(extractJob({ counts: { ...extractJob().counts, filesDone: 3 } }))).toBeNull()
		expect(extractJobSummary(extractJob({ outcome: { status: "wrongPassword" } }))).toBeNull()
		expect(extractJobSummary(extractJob({ outcome: { status: "quotaExceeded", neededBytes: 9, freeBytes: 1 } }))).toBeNull()
	})
})

describe("archiveJobNotes", () => {
	it("lists a compress's notes with their counts, leaving out the zero ones", () => {
		const notes = archiveJobNotes(
			compressJob({
				outcome: { status: "done" },
				renamed: cappedList([{ sourceUuid: "s", sourcePath: "a", name: "a (1)", reason: "duplicateName" }], 0),
				hashMismatches: cappedList([], 2),
				dispositions: [
					{ uuid: "k", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 0 } },
					{ uuid: "d", outcome: { type: "disposed", how: "trash", bytesFreed: 4 } }
				],
				stoppedAfterArchive: true
			})
		)

		expect(notes).toEqual([
			{ key: "transfersCopyRenamedNote", count: 1 },
			{ key: "transfersCompressHashMismatchNote", count: 2 },
			{ key: "transfersArchiveOriginalsKeptNote", count: 1 },
			{ key: "transfersCompressStoppedAfterArchiveNote", count: 1 }
		])
		expect(archiveJobNotes(compressJob({ lateArchive: true }))).toEqual([{ key: "transfersCompressLateArchiveNote", count: 1 }])
	})

	it("tells how many of an extract's skipped entries were macOS metadata, past the list's cap too", () => {
		const notes = archiveJobNotes(
			extractJob({
				skipped: cappedList(
					[
						skipped(0, { type: "macMetadata" }),
						skipped(1, { type: "symlink", target: "x" }),
						skipped(2, { type: "macMetadata" })
					],
					5
				),
				macMetadataSkippedCount: 6,
				savedAsVersionCount: 1,
				topLevelTrashedCount: 2
			})
		)

		expect(notes).toEqual([
			{ key: "transfersExtractSkippedNote", count: 8 },
			{ key: "transfersExtractMacMetadataNote", count: 6 },
			{ key: "transfersCopySavedAsVersionNote", count: 1 },
			{ key: "transfersExtractTopLevelTrashedNote", count: 2 }
		])
		expect(archiveJobNotes(extractJob({ skipped: EMPTY_CAPPED_LIST }))).toEqual([])
	})
})
