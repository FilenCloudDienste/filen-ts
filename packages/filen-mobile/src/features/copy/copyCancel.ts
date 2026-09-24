import { type TFunction } from "i18next"
import { run } from "@filen/shared"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import copyRunner from "@/features/copy/copyRunner"
import { getCopyJob } from "@/features/copy/store/useCopyJobs.store"

// A copy row's own cancel: keep what was copied, move it to the trash, or go on. The copy waits while
// the dialog is open. Generic cancels (Cancel all) never get here and always keep.
export async function stopCopyWithChoice(jobId: string, t: TFunction): Promise<void> {
	const pausedHere = copyRunner.holdForCancelChoice(jobId)
	const job = getCopyJob(jobId)

	const result = await run(async () => {
		return await prompts.confirm3({
			title: t("copy_stop_title"),
			// No count while the scan is still totalling, nor for a copy without files.
			message:
				job && job.phase !== "scanning" && job.totals.files > 0
					? t("copy_stop_message", {
							done: job.counts.filesDone,
							count: job.totals.files
						})
					: undefined,
			primaryText: t("copy_stop_keep"),
			destructiveText: t("copy_stop_trash"),
			cancelText: t("copy_continue")
		})
	})

	if (!result.success) {
		logger.warn("copy", "stop dialog failed", { jobId, error: result.error })
		alerts.error(result.error)

		await copyRunner.resolveCancelChoice(jobId, "continue", pausedHere)

		return
	}

	await copyRunner.resolveCancelChoice(
		jobId,
		result.data === "primary" ? "keep" : result.data === "destructive" ? "trash" : "continue",
		pausedHere
	)
}
