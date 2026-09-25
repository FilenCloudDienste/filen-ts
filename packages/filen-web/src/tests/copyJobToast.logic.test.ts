import { describe, expect, it } from "vitest"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import { narrowItem } from "@/features/drive/lib/item"
import { copyJobNotes, copyJobStatus, copyJobTitle } from "@/features/transfers/components/copyJobToast.logic"

function job(overrides: Partial<CopyJob> = {}): CopyJob {
	return { ...createCopyJob("j", { uuid: null, name: "Photos" }, 3), ...overrides }
}

const COPYING: Partial<CopyJob> = { phase: "copyingFiles", totals: { dirs: 0, files: 40, bytes: 1_000 } }

describe("copyJobTitle", () => {
	it("counts the items while copying and once copied, and names only the destination otherwise", () => {
		expect(copyJobTitle(job())).toEqual({ key: "transfersCopyCardTitleRunning", count: 3, destination: "Photos" })
		expect(copyJobTitle(job({ outcome: { status: "done" } }))).toEqual({
			key: "transfersCopyCardTitleDone",
			count: 3,
			destination: "Photos"
		})
		expect(copyJobTitle(job({ outcome: { status: "cancelled" } }))).toEqual({
			key: "transfersCopyCardTitleEnded",
			destination: "Photos"
		})
	})

	// The stop reached it only after the copy had finished; what it copied goes to the trash all the same.
	it("doesn't call a copy copied once its stop asked to trash what it made", () => {
		const done: Partial<CopyJob> = { outcome: { status: "done" }, cancelRequest: "trash" }

		expect(copyJobTitle(job(done))).toEqual({ key: "transfersCopyCardTitleEnded", destination: "Photos" })
		expect(copyJobTitle(job({ ...done, trashResult: { moved: 3, failed: 0 } }))).toEqual({
			key: "transfersCopyCardTitleEnded",
			destination: "Photos"
		})
		expect(copyJobTitle(job({ ...done, cancelRequest: "keep" }))).toEqual({
			key: "transfersCopyCardTitleDone",
			count: 3,
			destination: "Photos"
		})
	})
})

describe("copyJobStatus", () => {
	it("reads the phase while running, with files counted while copying them", () => {
		expect(copyJobStatus(job())).toEqual({ kind: "key", key: "transfersCopyPhaseScanning" })
		expect(copyJobStatus(job({ phase: "creatingDirectories" }))).toEqual({ kind: "key", key: "transfersCopyPhaseCreatingDirectories" })
		expect(copyJobStatus(job({ ...COPYING, counts: { ...job().counts, filesDone: 12 } }))).toEqual({
			kind: "files",
			done: 12,
			count: 40
		})
		expect(copyJobStatus(job({ phase: "finishing" }))).toEqual({ kind: "key", key: "transfersCopyPhaseFinishing" })
	})

	it("lets pausing, paused and stopping override the phase", () => {
		expect(copyJobStatus(job({ ...COPYING, pausing: true }))).toEqual({ kind: "key", key: "transfersCopyPhasePausing" })
		expect(copyJobStatus(job({ ...COPYING, paused: true }))).toEqual({ kind: "key", key: "transfersStatusPaused" })
		expect(copyJobStatus(job({ ...COPYING, cancelRequest: "keep" }))).toEqual({ kind: "key", key: "transfersCopyPhaseCancelling" })
		expect(copyJobStatus(job({ ...COPYING, cancelling: true, paused: true }))).toEqual({
			kind: "key",
			key: "transfersCopyPhaseCancelling"
		})
	})

	it("says how a settled copy ended", () => {
		const error = {
			species: "sdk" as const,
			kind: "Reqwest",
			message: "Error of kind Reqwest: error: error sending request for url (https://gateway.filen.io/v3/file/upload)",
			label: "Error of kind Reqwest: error: error sending request for url (https://gateway.filen.io/v3/file/upload)"
		}

		expect(copyJobStatus(job({ outcome: { status: "done" } }))).toEqual({ kind: "key", key: "transfersStatusDone" })
		expect(copyJobStatus(job({ outcome: { status: "quotaExceeded", neededBytes: 9, freeBytes: 7 } }))).toEqual({
			kind: "quota",
			neededBytes: 9,
			freeBytes: 7
		})
		// The error itself, put into words where it's shown so the text follows the language.
		expect(copyJobStatus(job({ outcome: { status: "failed", error } }))).toEqual({ kind: "error", error })
	})

	it("counts the failed items of a copy that finished with failures", () => {
		const failure = {
			sourceUuid: "s",
			sourcePath: "a",
			destName: "a",
			error: { species: "plain" as const, message: "m", label: "l" },
			affectedFiles: 1,
			affectedBytes: 1
		}

		expect(copyJobStatus(job({ outcome: { status: "doneWithFailures" }, failures: [failure, failure] }))).toEqual({
			kind: "key",
			key: "transfersCopyFailedItems",
			count: 2
		})
	})

	it("tells a kept stop from a trashed one and a trash that partly failed", () => {
		const cancelled: Partial<CopyJob> = { outcome: { status: "cancelled" } }

		expect(copyJobStatus(job(cancelled))).toEqual({ kind: "key", key: "transfersCopyCancelledKept" })
		expect(copyJobStatus(job({ ...cancelled, trashResult: { moved: 2, failed: 0 } }))).toEqual({
			kind: "key",
			key: "transfersCopyCancelledTrashed",
			count: 2
		})
		expect(copyJobStatus(job({ ...cancelled, trashResult: { moved: 1, failed: 1 } }))).toEqual({
			kind: "key",
			key: "transfersCopyCancelledTrashFailed"
		})
	})

	it("says the copies are moving to the trash until that settles, and only when there is something to move", () => {
		const copied = narrowItem({
			uuid: "d-0000-0000-0000-000000000000",
			parent: "p-0000-0000-0000-000000000000",
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "d" } }
		})
		const stopping: Partial<CopyJob> = { outcome: { status: "cancelled" }, cancelRequest: "trash", created: [copied] }

		expect(copyJobStatus(job(stopping))).toEqual({ kind: "key", key: "transfersCopyMovingToTrash" })
		// A late item's trash can record its result before the stop's batch is done.
		expect(copyJobStatus(job({ ...stopping, trashResult: { moved: 1, failed: 0 } }))).toEqual({
			kind: "key",
			key: "transfersCopyMovingToTrash"
		})
		expect(copyJobStatus(job({ ...stopping, outcome: { status: "done" }, trashResult: { moved: 1, failed: 0 } }))).toEqual({
			kind: "key",
			key: "transfersCopyMovingToTrash"
		})
		expect(copyJobStatus(job({ ...stopping, created: [] }))).toEqual({ kind: "key", key: "transfersCopyCancelledKept" })
		expect(copyJobStatus(job({ ...stopping, created: [], trashResult: { moved: 1, failed: 0 } }))).toEqual({
			kind: "key",
			key: "transfersCopyCancelledTrashed",
			count: 1
		})
	})

	// The stop reached it only after the copy had finished; what it copied goes to the trash all the same.
	it("says what the trash did for a copy that finished before its stop reached it", () => {
		for (const outcome of [{ status: "done" }, { status: "doneWithFailures" }] as const) {
			const finished: Partial<CopyJob> = { outcome, cancelRequest: "trash", failures: [] }

			expect(copyJobStatus(job({ ...finished, trashResult: { moved: 3, failed: 0 } }))).toEqual({
				kind: "key",
				key: "transfersCopyTrashed",
				count: 3
			})
			expect(copyJobStatus(job({ ...finished, trashResult: { moved: 2, failed: 1 } }))).toEqual({
				kind: "key",
				key: "transfersCopyTrashFailed"
			})
		}
	})

	it("tells what the trash did after a failed copy's error", () => {
		const error = { species: "plain" as const, message: "offline", label: "offline" }
		const failed: Partial<CopyJob> = { outcome: { status: "failed", error }, cancelRequest: "trash" }

		expect(copyJobStatus(job({ ...failed, trashResult: { moved: 2, failed: 1 } }))).toEqual({
			kind: "error",
			error,
			trash: { kind: "key", key: "transfersCopyTrashFailed" }
		})
		expect(copyJobStatus(job({ ...failed, trashResult: { moved: 3, failed: 0 } }))).toEqual({
			kind: "error",
			error,
			trash: { kind: "key", key: "transfersCopyTrashed", count: 3 }
		})
		expect(copyJobStatus(job(failed))).toEqual({ kind: "error", error })
	})
})

describe("copyJobNotes", () => {
	it("lists only the notes with something to say", () => {
		expect(copyJobNotes(job())).toEqual([])
		expect(copyJobNotes(job({ renamedCount: 2, savedAsVersionCount: 1, counts: { ...job().counts, entriesSkipped: 3 } }))).toEqual([
			{ key: "transfersCopyRenamedNote", count: 2 },
			{ key: "transfersCopySkippedNote", count: 3 },
			{ key: "transfersCopySavedAsVersionNote", count: 1 }
		])
	})
})
