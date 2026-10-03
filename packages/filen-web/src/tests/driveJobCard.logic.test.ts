import { describe, expect, it } from "vitest"
import { cappedList } from "@filen/shared"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { jobCancelPrompt, jobCardDuration, jobCardModel } from "@/features/transfers/components/driveJobCard.logic"
import { copyCardDuration, copyJobNotes, copyJobStatus } from "@/features/transfers/components/copyJobToast.logic"
import { ARCHIVE_ITEM, compressJob, createdDirectory, extractFailure, extractJob } from "@/tests/support/archiveJobFixtures"

const ERROR = { species: "plain" as const, message: "offline", label: "offline" }
const NO_SLOT = { slotHeldWhilePaused: false }

function copyJob(overrides: Partial<CopyJob> = {}): CopyJob {
	return { ...createCopyJob("job", { uuid: null, name: "Photos" }, 3), ...overrides }
}

const COPYING: Partial<CopyJob> = {
	phase: "copyingFiles",
	totals: { dirs: 1, files: 40, bytes: 4_000_000 },
	counts: { ...copyJob().counts, filesDone: 12, bytesDone: 1_000_000 },
	bytesPerSecond: 500_000,
	etaMs: 6_000,
	active: [{ destUuid: "d", name: "holiday.jpg", size: 2_048, bytesDone: 1_024 }]
}

describe("jobCardDuration", () => {
	it("goes through each kind's own reading", () => {
		const copy = copyJob({ outcome: { status: "doneWithFailures" } })

		expect(jobCardDuration(copy)).toBe(copyCardDuration(copy))
		expect(jobCardDuration(compressJob())).toBe(Infinity)
		expect(jobCardDuration(compressJob({ outcome: { status: "done" } }))).toBe(4_000)
		expect(jobCardDuration(extractJob({ outcome: { status: "passwordRequired" } }))).toBe(Infinity)
		expect(jobCardDuration(extractJob({ outcome: { status: "doneWithIssues" } }))).toBe(8_000)
	})
})

describe("jobCardModel for a copy", () => {
	it("reads the copy through its own functions, offering nothing an archive job does", () => {
		const job = copyJob(COPYING)
		const model = jobCardModel(job, { slotHeldWhilePaused: true })

		expect(model.title).toEqual({ key: "transfersCopyCardTitleRunning", values: { count: 3, destination: "Photos" } })
		expect(model.status).toEqual(copyJobStatus(job))
		expect(model.notes).toEqual(copyJobNotes(job))
		expect(model.percent).toBe(25)
		expect(model.bytes).toEqual({ done: 1_000_000, total: 4_000_000 })
		expect(model.rate).toEqual({ bytesPerSecond: 500_000, etaSeconds: 6 })
		expect(model.summary).toBeNull()
		// A copy never holds the archive slot.
		expect(model.warnings).toEqual([])
		expect(model.details.active).toEqual([{ key: "d", name: "holiday.jpg", done: 1_024, size: 2_048 }])
		expect(model.actions).toEqual({ pauseCancel: true, retry: null, report: false, password: false, showDirectory: null })
		expect(model.labels.dismiss).toBe("transfersCopyCardDismiss")
	})

	it("names only the destination once it ended any other way, and marks a failure", () => {
		const model = jobCardModel(copyJob({ outcome: { status: "failed", error: ERROR } }), NO_SLOT)

		expect(model.title).toEqual({ key: "transfersCopyCardTitleEnded", values: { destination: "Photos" } })
		expect(model.statusFailed).toBe(true)
		expect(model.bytes).toBeNull()
	})

	it("offers a retry of the failures beside them", () => {
		const failure = { sourceUuid: "s", sourcePath: "dir/a", destName: "a", error: ERROR }
		const job = copyJob({ outcome: { status: "doneWithFailures" }, failures: [failure], retryable: [] })

		expect(jobCardModel(job, NO_SLOT).details.failures).toEqual([{ key: "s:a", path: "dir/a", error: ERROR }])
		expect(jobCardModel(job, NO_SLOT).actions.retry).toBeNull()
	})
})

describe("jobCardModel for a compress", () => {
	it("shows the share of the work done, the file being read and the slot warning", () => {
		const job = compressJob({
			phase: "compressing",
			paused: true,
			totals: { dirs: 0, files: 4, bytes: 1_000 },
			counts: { ...compressJob().counts, bytesRead: 500 },
			active: [{ sourceUuid: "s", name: "a.jpg", path: "dir/a.jpg", size: 10, bytesDone: 5 }]
		})
		const model = jobCardModel(job, { slotHeldWhilePaused: true })

		expect(model.title.key).toBe("transfersCompressCardTitleRunning")
		expect(model.percent).toBe(50)
		expect(model.bytes).toEqual({ done: 500, total: 1_000 })
		expect(model.details.active).toEqual([{ key: "s", name: "a.jpg", done: 5, size: 10 }])
		expect(model.warnings).toEqual([{ key: "transfersJobSlotHeldWarning", count: 1 }])
		expect(model.actions.pauseCancel).toBe(true)
		expect(model.labels.tabNote).toBe("transfersCompressTabNote")
	})

	it("offers a rerun of a failed compress and the saved archive of a finished one", () => {
		expect(jobCardModel(compressJob({ outcome: { status: "failed", error: ERROR } }), NO_SLOT).actions).toMatchObject({
			pauseCancel: false,
			retry: "rerun",
			showDirectory: null
		})
		expect(
			jobCardModel(compressJob({ outcome: { status: "quotaExceeded", neededBytes: null, freeBytes: 1 } }), NO_SLOT).statusFailed
		).toBe(true)

		const done = jobCardModel(compressJob({ outcome: { status: "done" }, archive: ARCHIVE_ITEM }), NO_SLOT)

		expect(done.actions).toEqual({ pauseCancel: false, retry: null, report: false, password: false, showDirectory: ARCHIVE_ITEM })
		expect(done.statusFailed).toBe(false)
	})

	it("offers the report of a compress that left something out", () => {
		const job = compressJob({ outcome: { status: "doneWithIssues" }, hashMismatches: cappedList([{ sourceUuid: "s", path: "a" }], 0) })

		expect(jobCardModel(job, NO_SLOT).actions.report).toBe(true)
	})
})

describe("jobCardModel for an extract", () => {
	it("sums up the result, warns about misleading names and lists the failures with a retry", () => {
		const failures = cappedList(
			Array.from({ length: 22 }, (_, index) => extractFailure(`f${String(index)}`, index, ERROR)),
			3
		)
		const model = jobCardModel(
			extractJob({
				outcome: { status: "doneWithIssues" },
				counts: { ...extractJob().counts, filesDone: 7 },
				failures,
				misleadingNames: cappedList([{ entry: { archive: "a", index: 0 }, path: "invoice‮fdp.exe" }], 0),
				firstCreated: createdDirectory("photos")
			}),
			NO_SLOT
		)

		expect(model.summary).toEqual({ extracted: 7, skipped: 0, failed: 25 })
		expect(model.warnings).toEqual([{ key: "transfersExtractMisleadingNamesWarning", count: 1 }])
		expect(model.details.failures).toHaveLength(20)
		expect(model.details.failures[0]).toEqual({ key: `${failures.items[0]?.entry.archive ?? ""}:0`, path: "f0", error: ERROR })
		expect(model.details.moreFailures).toBe(5)
		expect(model.actions).toMatchObject({ retry: "failed", report: true, password: false })
		expect(model.actions.showDirectory).toEqual(createdDirectory("photos"))
	})

	it("asks for the password, marking a wrong one as failed", () => {
		const required = jobCardModel(extractJob({ outcome: { status: "passwordRequired" } }), NO_SLOT)
		const wrong = jobCardModel(extractJob({ outcome: { status: "wrongPassword" } }), NO_SLOT)

		expect(required.actions.password).toBe(true)
		expect(required.statusFailed).toBe(false)
		expect(wrong.actions.password).toBe(true)
		expect(wrong.statusFailed).toBe(true)
	})

	it("offers nothing to go and see once a stop sent it to the trash", () => {
		const job = extractJob({ outcome: { status: "cancelled" }, cancelRequest: "trash", firstCreated: createdDirectory("photos") })

		expect(jobCardModel(job, NO_SLOT).actions.showDirectory).toBeNull()
	})

	it("reads an unknown entry size as unknown", () => {
		const job = extractJob({
			phase: "extracting",
			active: [{ entry: { archive: "a", index: 3 }, destUuid: "d", destParent: "p", name: "a.txt", size: null, bytesDone: 2 }]
		})

		expect(jobCardModel(job, NO_SLOT).details.active).toEqual([{ key: "d", name: "a.txt", done: 2, size: null }])
	})
})

describe("jobCancelPrompt", () => {
	it("is open while the job runs and no stop was asked for", () => {
		expect(jobCancelPrompt(undefined)).toBeNull()
		expect(jobCancelPrompt(copyJob())).toEqual({
			open: true,
			kind: "copy",
			destination: "Photos",
			afterArchive: false,
			disposingArchive: false
		})
		expect(jobCancelPrompt(extractJob({ cancelRequest: "keep" }))?.open).toBe(false)
		expect(jobCancelPrompt(compressJob({ outcome: { status: "done" } }))?.open).toBe(false)
	})

	it("tells a compress whose archive is already saved", () => {
		expect(jobCancelPrompt(compressJob({ phase: "compressing" }))?.afterArchive).toBe(false)
		expect(jobCancelPrompt(compressJob({ phase: "verifying" }))?.afterArchive).toBe(true)
		expect(jobCancelPrompt(compressJob({ phase: "disposingSources" }))?.afterArchive).toBe(true)
	})

	it("tells an extract whose archive is being removed", () => {
		expect(jobCancelPrompt(extractJob({ phase: "extracting", dispose: "trash" }))?.disposingArchive).toBe(false)
		expect(jobCancelPrompt(extractJob({ phase: "disposingSources", dispose: "trash" }))?.disposingArchive).toBe(true)
		expect(jobCancelPrompt(extractJob({ phase: "disposingSources", dispose: null }))?.disposingArchive).toBe(false)
		expect(jobCancelPrompt(compressJob({ phase: "disposingSources", dispose: "trash" }))?.disposingArchive).toBe(false)
	})
})
