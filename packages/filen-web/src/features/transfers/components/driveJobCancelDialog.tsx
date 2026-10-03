import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { requestJobCancel, type JobStopMode } from "@/features/transfers/lib/control"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { jobCancelPrompt, type JobCancelPrompt } from "@/features/transfers/components/driveJobCard.logic"
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

// The one stop prompt for a drive job (copy, compress, extract), for whichever surface asked (the progress
// card or its transfers row), mounted once at the root beside the toasts. It closes by itself once the job
// is no longer running — a job that finished while the prompt was open has nothing left to stop.
//
// A copy or extract can keep what it made (the default, holding the initial focus) or move it to the
// trash, which only ever touches the top-level items the job created; an extract already removing its
// archive only keeps. A compress leaves nothing behind unless its archive is already saved, which a stop
// then keeps along with the originals not yet removed.
export function DriveJobCancelDialog() {
	const { t } = useTranslation("transfers")
	const jobId = useDriveJobsStore(state => state.cancelPromptId)
	const prompt = useDriveJobsStore(
		useShallow(state => jobCancelPrompt(state.cancelPromptId === null ? undefined : state.jobs[state.cancelPromptId]))
	)
	// The last prompt shown keeps its words through the exit animation, after a stop clears the id or the
	// settled job leaves the store. `prompt` is stable while unchanged, so this sets state only on a change.
	const [shown, setShown] = useState<JobCancelPrompt | null>(prompt)

	if (prompt !== null && prompt !== shown) {
		setShown(prompt)
	}

	const view = prompt ?? shown
	const destination = view?.destination ?? ""

	function close(): void {
		useDriveJobsStore.getState().setCancelPromptId(null)
	}

	function stop(mode: JobStopMode): void {
		if (jobId !== null) {
			requestJobCancel(jobId, mode)
		}

		close()
	}

	let content: { title: string; body: string; continueLabel: string; trashLabel: string | null; stopLabel: string }

	switch (view?.kind) {
		case "compress":
			content = {
				title: t("transfersCompressCancelTitle"),
				body: view.afterArchive ? t("transfersCompressCancelBodyAfterArchive", { destination }) : t("transfersCompressCancelBody"),
				continueLabel: t("transfersCompressCancelContinue"),
				trashLabel: null,
				stopLabel: t("transfersCompressCancelStop")
			}

			break
		case "extract":
			content = {
				title: t("transfersExtractCancelTitle"),
				body: view.disposingArchive
					? t("transfersExtractCancelBodyDisposing", { destination })
					: t("transfersExtractCancelBody", { destination }),
				continueLabel: t("transfersExtractCancelContinue"),
				trashLabel: view.disposingArchive ? null : t("transfersExtractCancelTrash"),
				stopLabel: t("transfersExtractCancelKeep")
			}

			break
		default:
			content = {
				title: t("transfersCopyCancelTitle"),
				body: t("transfersCopyCancelBody", { destination }),
				continueLabel: t("transfersCopyCancelContinue"),
				trashLabel: t("transfersCopyCancelTrash"),
				stopLabel: t("transfersCopyCancelKeep")
			}
	}

	const { trashLabel } = content

	return (
		<AlertDialog
			open={prompt?.open === true}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onOpenChangeComplete={opened => {
				// A job that ended by itself closed the prompt; its id must not reopen it for a rerun.
				if (!opened && jobId !== null && useDriveJobsStore.getState().cancelPromptId === jobId) {
					close()
				}
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{content.title}</AlertDialogTitle>
					<AlertDialogDescription>{content.body}</AlertDialogDescription>
				</AlertDialogHeader>
				{/* Three long labels never fit one row, so they stack at every width, the default on top. */}
				<AlertDialogFooter className={trashLabel === null ? undefined : "sm:flex-col-reverse sm:justify-start"}>
					<AlertDialogCancel>{content.continueLabel}</AlertDialogCancel>
					{trashLabel === null ? null : (
						<Button
							variant="destructive"
							onClick={() => {
								stop("trash")
							}}
						>
							{trashLabel}
						</Button>
					)}
					<Button
						autoFocus
						onClick={() => {
							stop("keep")
						}}
					>
						{content.stopLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
