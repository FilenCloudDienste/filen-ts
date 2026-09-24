import { type TFunction } from "i18next"
import { bpsToReadable, copyJobPercent, copyJobRate } from "@filen/shared"
import type { CopyJob } from "@/features/copy/copyAdapter"
import { getCopyJob } from "@/features/copy/store/useCopyJobs.store"
import type { FinishedTransfer, Transfer } from "@/features/transfers/store/useTransfers.store"

// The items being copied when copies are all that runs, for the floating bar and the Android
// notification; null when anything else runs too (or nothing does).
export function copyingItemCount(transfers: readonly Transfer[]): number | null {
	if (transfers.length === 0) {
		return null
	}

	let items = 0

	for (const transfer of transfers) {
		if (transfer.type !== "copy") {
			return null
		}

		items += getCopyJob(transfer.id)?.itemCount ?? 1
	}

	return items
}

// A running copy's state line: one text, no second icon.
export function copyRowStatus(job: CopyJob | undefined, rowPaused: boolean, t: TFunction): string {
	if (!job) {
		return t("copy_preparing")
	}

	if (job.cancelling || job.cancelRequest !== null) {
		return t("copy_stopping")
	}

	if (rowPaused || job.paused) {
		return t("copy_paused")
	}

	if (job.phase === "finishing") {
		return t("copy_finishing")
	}

	const percent = copyJobPercent(job)

	if (percent === null) {
		return t("copy_preparing")
	}

	const done = job.counts.filesDone
	// The plural form follows the total.
	const count = job.totals.files
	const percentText = Math.floor(percent).toString()
	// The rate reads like an upload row's, shown once the SDK has one.
	const rate = copyJobRate(job)

	return rate
		? t("copy_progress_files_speed", {
				done,
				count,
				percent: percentText,
				speed: bpsToReadable(rate.bytesPerSecond)
			})
		: t("copy_progress_files", {
				done,
				count,
				percent: percentText
			})
}

// A finished copy's title. A stopped copy's row exists only while "move to trash" left items behind;
// an error, a storage refusal or a copy that made nothing reads as failed.
export function copyFinishedTitle(finished: FinishedTransfer, t: TFunction): string {
	const name = finished.name

	if (finished.outcome === "errored") {
		return (finished.copyTrashFailed ?? 0) > 0 ? t("copy_row_stopped_title", { name }) : t("copy_row_failed_title", { name })
	}

	return finished.copyNothingCopied ? t("copy_row_failed_title", { name }) : t("copy_row_finished_title", { name })
}

// A finished copy's notes line, zero counts left out; null when there is nothing to note.
export function copyNotesText(notes: FinishedTransfer["copyNotes"], t: TFunction): string | null {
	if (!notes) {
		return null
	}

	const parts: string[] = []

	if (notes.skipped > 0) {
		parts.push(t("copy_notes_skipped", { count: notes.skipped }))
	}

	if (notes.renamed > 0) {
		parts.push(t("copy_notes_renamed", { count: notes.renamed }))
	}

	if (notes.savedAsVersion > 0) {
		parts.push(t("copy_notes_saved_as_version", { count: notes.savedAsVersion }))
	}

	if (notes.propagationFailed > 0) {
		parts.push(t("copy_notes_sharing_not_applied", { count: notes.propagationFailed }))
	}

	return parts.length > 0 ? parts.join(" · ") : null
}
