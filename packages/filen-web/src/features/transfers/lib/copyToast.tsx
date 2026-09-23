import { toast } from "sonner"
import { CopyJobToast } from "@/features/transfers/components/copyJobToast"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { pruneSettledCopyJobs, startCopy } from "@/features/drive/lib/copy"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { type DriveItem } from "@/features/drive/lib/item"

function toastId(jobId: string): string {
	return `copy:${jobId}`
}

// A copy's progress card is a persistent custom toast in the normal stack. Issuing it again for the same
// job only replaces its element, which is also how a card that changed height gets re-measured by the
// stack (sonner measures a custom toast when its element changes, not when its content grows).
export function showCopyToast(jobId: string): void {
	if (getCopyJob(jobId) === undefined) {
		return
	}

	useCopyJobsStore.getState().update(jobId, job => (job.cardVisible ? job : { ...job, cardVisible: true }))

	toast.custom(
		() => (
			<CopyJobToast
				jobId={jobId}
				onHeightChange={() => {
					showCopyToast(jobId)
				}}
				onDismiss={() => {
					toast.dismiss(toastId(jobId))
				}}
				onRetried={retryId => {
					toast.dismiss(toastId(jobId))
					showCopyToast(retryId)
				}}
			/>
		),
		{
			id: toastId(jobId),
			duration: Infinity,
			// Every way the card goes away — its ✕, a swipe — ends here: the job keeps running, and a
			// settled one without a transfers row to reopen it is dropped.
			onDismiss: () => {
				useCopyJobsStore.getState().update(jobId, job => ({ ...job, cardVisible: false }))
				pruneSettledCopyJobs()
			}
		}
	)
}

export function hideCopyToast(jobId: string): void {
	toast.dismiss(toastId(jobId))
}

// Every copy the user starts shows its card; the card is shown before the job can settle, so a quick
// copy ends on its card rather than on a toast.
export function startCopyWithCard(items: DriveItem[], destination: CopyDestination): string | null {
	const id = startCopy(items, destination)

	if (id !== null) {
		showCopyToast(id)
	}

	return id
}
