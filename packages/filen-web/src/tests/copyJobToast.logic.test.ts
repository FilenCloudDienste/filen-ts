import { describe, expect, it } from "vitest"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import {
	copyJobNotes,
	copyJobPercent,
	copyJobRate,
	copyJobStatus,
	copyJobTitle,
	isCopyJobRunning
} from "@/features/transfers/components/copyJobToast.logic"

function job(overrides: Partial<CopyJob> = {}): CopyJob {
	return { ...createCopyJob("j", { uuid: null, name: "Photos" }, 3), ...overrides }
}

const COPYING: Partial<CopyJob> = { phase: "copyingFiles", totals: { dirs: 0, files: 40, bytes: 1_000 } }

describe("copyJobPercent", () => {
	it("is indeterminate while the scan still grows the total", () => {
		expect(copyJobPercent(job())).toBeNull()
		expect(copyJobPercent(job({ phase: "copyingFiles" }))).toBeNull()
	})

	it("is the share of bytes copied once the total is known", () => {
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 250 } }))).toBe(25)
	})

	it("is full once done, and frozen where a stopped copy left off", () => {
		expect(copyJobPercent(job({ outcome: { status: "done" } }))).toBe(100)
		expect(copyJobPercent(job({ ...COPYING, counts: { ...job().counts, bytesDone: 500 }, outcome: { status: "cancelled" } }))).toBe(50)
	})
})

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
		expect(copyJobStatus(job({ outcome: { status: "done" } }))).toEqual({ kind: "key", key: "transfersStatusDone" })
		expect(copyJobStatus(job({ outcome: { status: "quotaExceeded", freeBytes: 7 } }))).toEqual({ kind: "quota", freeBytes: 7 })
		expect(
			copyJobStatus(job({ outcome: { status: "failed", error: { species: "plain", message: "m", label: "Server said no" } } }))
		).toEqual({ kind: "error", label: "Server said no" })
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
})

describe("copyJobRate", () => {
	it("gives speed and seconds left only while bytes move", () => {
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, etaMs: 1_500 }))).toEqual({ bytesPerSecond: 2_000, etaSeconds: 2 })
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, etaMs: null }))).toEqual({ bytesPerSecond: 2_000, etaSeconds: null })
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: null }))).toBeNull()
		expect(copyJobRate(job({ ...COPYING, bytesPerSecond: 2_000, paused: true }))).toBeNull()
		expect(copyJobRate(job({ bytesPerSecond: 2_000, outcome: { status: "done" } }))).toBeNull()
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

describe("isCopyJobRunning", () => {
	it("is true only until the job settles", () => {
		expect(isCopyJobRunning(job())).toBe(true)
		expect(isCopyJobRunning(job({ outcome: { status: "cancelled" } }))).toBe(false)
	})
})
