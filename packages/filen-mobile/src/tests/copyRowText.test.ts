import { describe, it, expect, beforeEach } from "vitest"
import { bpsToReadable, createCopyJob as createSharedCopyJob } from "@filen/shared"
import i18next, { type TFunction } from "i18next"
import { copyFinishedTitle, copyingItemCount, copyNotesText, copyRowStatus } from "@/features/copy/copyRowText"
import useCopyJobsStore from "@/features/copy/store/useCopyJobs.store"
import type { CopyJob } from "@/features/copy/copyAdapter"
import type { FinishedTransfer, Transfer } from "@/features/transfers/store/useTransfers.store"
import { en } from "@/locales/en"

const t = ((key: string, options?: Record<string, unknown>) =>
	options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction

// The English catalog as the app configures i18next, so plural forms resolve for real.
const english = i18next.createInstance()

void english.init({
	resources: {
		en: {
			translation: en
		}
	},
	lng: "en",
	keySeparator: false,
	nsSeparator: false,
	interpolation: {
		escapeValue: false
	},
	initAsync: false
})

const realT = english.t.bind(english) as unknown as TFunction

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

		expect(copyRowStatus(copying, false, t)).toBe('copy_progress_files:{"done":340,"count":812,"percent":"43"}')
	})

	it("adds the rate, formatted like an upload row's, once the SDK reports one", () => {
		const copying = job({
			phase: "copyingFiles",
			totals: { dirs: 0, files: 812, bytes: 1000 },
			counts: { ...job().counts, filesDone: 340, bytesDone: 437 },
			bytesPerSecond: 2_202_010
		})

		expect(copyRowStatus(copying, false, t)).toBe(
			`copy_progress_files_speed:{"done":340,"count":812,"percent":"43","speed":"${bpsToReadable(2_202_010)}"}`
		)
		// No rate yet, or a zero rate: the line without it.
		expect(copyRowStatus({ ...copying, bytesPerSecond: 0 }, false, t)).toBe(
			'copy_progress_files:{"done":340,"count":812,"percent":"43"}'
		)
	})

	it("takes the plural form from the total: one file reads singular", () => {
		const single = job({
			phase: "copyingFiles",
			totals: { dirs: 0, files: 1, bytes: 1000 },
			counts: { ...job().counts, filesDone: 0, bytesDone: 370 }
		})

		expect(copyRowStatus(single, false, realT)).toBe("0 of 1 file · 37%")
		expect(copyRowStatus({ ...single, bytesPerSecond: 2_202_010 }, false, realT)).toBe(
			`0 of 1 file · 37% · ${bpsToReadable(2_202_010)}`
		)
		expect(copyRowStatus({ ...single, totals: { dirs: 0, files: 2, bytes: 1000 } }, false, realT)).toBe("0 of 2 files · 37%")
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

	it("reads every note in its plural form", () => {
		expect(copyNotesText({ skipped: 0, renamed: 0, savedAsVersion: 1, propagationFailed: 0 }, realT)).toBe("1 saved as a new version")
		expect(copyNotesText({ skipped: 2, renamed: 1, savedAsVersion: 2, propagationFailed: 3 }, realT)).toBe(
			"2 skipped · 1 renamed · 2 saved as new versions · sharing not applied to 3"
		)
	})
})

describe("copyFinishedTitle", () => {
	function finished(overrides: Partial<FinishedTransfer> = {}): FinishedTransfer {
		return {
			id: "job",
			type: "copy",
			name: "Vacation",
			size: 0,
			bytesTransferred: 0,
			startedAt: 0,
			finishedAt: 0,
			outcome: "succeeded",
			errorMessage: null,
			errorCount: 0,
			copyNothingCopied: false,
			...overrides
		}
	}

	it("a copy that ended in an error or a storage refusal reads failed, never copied", () => {
		expect(
			copyFinishedTitle(finished({ outcome: "errored", errorMessage: "Not enough storage: needs 2 GB, 1 GB free." }), realT)
		).toBe("Couldn't copy Vacation")
		// Its trash retry succeeded: the error row stays failed.
		expect(copyFinishedTitle(finished({ outcome: "errored", errorMessage: "Network error", copyTrashFailed: 0 }), realT)).toBe(
			"Couldn't copy Vacation"
		)
	})

	it("an errored row still holding untrashed copies reads stopped", () => {
		expect(copyFinishedTitle(finished({ outcome: "errored", copyTrashFailed: 2 }), realT)).toBe("Stopped copying Vacation")
	})

	it("a copy without a job error reads copied, unless every entry failed", () => {
		expect(copyFinishedTitle(finished(), realT)).toBe("Copied Vacation")
		expect(copyFinishedTitle(finished({ outcome: "completedWithErrors", errorCount: 2 }), realT)).toBe("Copied Vacation")
		expect(copyFinishedTitle(finished({ outcome: "completedWithErrors", errorCount: 3, copyNothingCopied: true }), realT)).toBe(
			"Couldn't copy Vacation"
		)
		// A finished copy whose trash left items behind still copied them.
		expect(copyFinishedTitle(finished({ copyTrashFailed: 1 }), realT)).toBe("Copied Vacation")
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
