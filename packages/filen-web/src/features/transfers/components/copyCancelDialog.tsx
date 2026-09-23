import { useTranslation } from "react-i18next"
import { requestCopyCancel } from "@/features/drive/lib/copy"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
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

// The one stop-copying prompt, for whichever surface asked (the progress card or its transfers row),
// mounted once at the root beside the toasts. It closes by itself once the job is no longer running —
// a copy that finished while the prompt was open has nothing left to stop. Keeping what was copied is
// the default and holds the initial focus; moving it to the trash only ever touches the top-level items
// this copy created.
export function CopyCancelDialog() {
	const { t } = useTranslation("transfers")
	const jobId = useCopyJobsStore(state => state.cancelPromptId)
	const job = useCopyJobsStore(state => (state.cancelPromptId === null ? undefined : state.jobs[state.cancelPromptId]))
	const open = job?.outcome.status === "running" && job.cancelRequest === null

	function close(): void {
		useCopyJobsStore.getState().setCancelPromptId(null)
	}

	function stop(trashCopied: boolean): void {
		if (jobId !== null) {
			requestCopyCancel(jobId, { trashCopied })
		}

		close()
	}

	return (
		<AlertDialog
			open={open}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("transfersCopyCancelTitle")}</AlertDialogTitle>
					<AlertDialogDescription>
						{t("transfersCopyCancelBody", { destination: job?.destination.name ?? "" })}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* Three long labels never fit one row, so they stack at every width, the default on top. */}
				<AlertDialogFooter className="sm:flex-col-reverse sm:justify-start">
					<AlertDialogCancel>{t("transfersCopyCancelContinue")}</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={() => {
							stop(true)
						}}
					>
						{t("transfersCopyCancelTrash")}
					</Button>
					<Button
						autoFocus
						onClick={() => {
							stop(false)
						}}
					>
						{t("transfersCopyCancelKeep")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
