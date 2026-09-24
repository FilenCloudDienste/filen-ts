import { describe, it, expect, beforeEach } from "vitest"
import { bpsToReadable, createCopyJob as createSharedCopyJob } from "@filen/shared"
import type { TFunction } from "i18next"
import { copyingItemCount, copyNotesText, copyRowStatus } from "@/features/copy/copyRowText"
import useCopyJobsStore from "@/features/copy/store/useCopyJobs.store"
import type { CopyJob } from "@/features/copy/copyAdapter"
import type { Transfer } from "@/features/transfers/store/useTransfers.store"

const t = ((key: string, options?: Record<string, unknown>) =>
	options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction

function job(overrides: Partial<CopyJob> = {}, itemCount = 1): CopyJob {
	return {
		...createSharedCopyJob("job", { uuid: "dest", name: "Dest" }, itemCount),
		glyph: "file",
		...overrides
	} as CopyJob
}

function row(id: string, type: "copy" | "uploadFile"): Transfer {
	return { id, type } as unknown as Transfer
}

beforeEach(() => {
	useCopyJobsStore.getState().clear()
})

describe("copyRowStatus", () => {
	it("reads preparing before the job exists and while the total is unknown", () => {
		expect(copyRowStatus(undefined, false, t)).toBe("copy_preparing")
		expect(copyRowStatus(job(), false, t)).toBe("copy_preparing")
	})

	it("shows files and percent while copying", () => {
		const copying = job({
			phase: "copyingFiles",
			totals: { dirs: 0, files: 812, bytes: 1000 },
			counts: { ...job().counts, filesDone: 340, bytesDone: 437 }
		})

		expect(copyRowStatus(copying, false, t)).toBe('copy_progress_files:{"done":"340","total":"812","percent":"43"}')
	})

	it("adds the rate, formatted like an upload row's, once the SDK reports one", () => {
		const copying = job({
			phase: "copyingFiles",
			totals: { dirs: 0, files: 812, bytes: 1000 },
			counts: { ...job().counts, filesDone: 340, bytesDone: 437 },
			bytesPerSecond: 2_202_010
		})

		expect(copyRowStatus(copying, false, t)).toBe(
			`copy_progress_files_speed:{"done":"340","total":"812","percent":"43","speed":"${bpsToReadable(2_202_010)}"}`
		)
		// No rate yet, or a zero rate: the line without it.
		expect(copyRowStatus({ ...copying, bytesPerSecond: 0 }, false, t)).toBe(
			'copy_progress_files:{"done":"340","total":"812","percent":"43"}'
		)
	})

	it("stopping outranks paused, paused outranks finishing", () => {
		const finishing = job({ phase: "finishing", totals: { dirs: 0, files: 1, bytes: 10 } })

		expect(copyRowStatus(finishing, false, t)).toBe("copy_finishing")
		expect(copyRowStatus(finishing, true, t)).toBe("copy_paused")
		expect(copyRowStatus({ ...finishing, paused: true }, false, t)).toBe("copy_paused")
		expect(copyRowStatus({ ...finishing, cancelRequest: "keep" }, true, t)).toBe("copy_stopping")
		expect(copyRowStatus({ ...finishing, cancelling: true }, false, t)).toBe("copy_stopping")
	})
})

describe("copyNotesText", () => {
	it("joins the non-zero notes and is null when there are none", () => {
		expect(copyNotesText(undefined, t)).toBeNull()
		expect(copyNotesText({ skipped: 0, renamed: 0, savedAsVersion: 0, propagationFailed: 0 }, t)).toBeNull()
		expect(copyNotesText({ skipped: 2, renamed: 1, savedAsVersion: 0, propagationFailed: 1 }, t)).toBe(
			'copy_notes_skipped:{"count":2} · copy_notes_renamed:{"count":1} · copy_notes_sharing_not_applied:{"count":1}'
		)
	})
})

describe("copyingItemCount", () => {
	it("sums the items of copy rows when copies are all that runs", () => {
		useCopyJobsStore.getState().put({ ...job({}, 10), id: "a" })
		useCopyJobsStore.getState().put({ ...job({}, 2), id: "b" })

		expect(copyingItemCount([row("a", "copy"), row("b", "copy")])).toBe(12)
		// A row whose job is not in the store yet counts as one item.
		expect(copyingItemCount([row("a", "copy"), row("c", "copy")])).toBe(11)
	})

	it("is null with no rows or when anything else runs", () => {
		useCopyJobsStore.getState().put({ ...job({}, 10), id: "a" })

		expect(copyingItemCount([])).toBeNull()
		expect(copyingItemCount([row("a", "copy"), row("u", "uploadFile")])).toBeNull()
		expect(copyingItemCount([row("u", "uploadFile"), row("a", "copy")])).toBeNull()
	})
})
