import { toast } from "sonner"
import { CopyJobToast } from "@/features/transfers/components/copyJobToast"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { pruneSettledCopyJobs, startCopy } from "@/features/drive/lib/copy"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { type DriveItem } from "@/features/drive/lib/item"

// The toast id of each job's card while it is showing. A card reopened after being hidden gets a fresh
// id: a leaving toast stays in sonner's list for its exit animation, and a toast issued under the same
// id meanwhile is merged into it and leaves with it.
const showingIds = new Map<string, string>()
let showings = 0

// A copy's progress card is a persistent custom toast in the normal stack. Issuing it again while it
// shows only replaces its element, which is also how a card that changed height gets re-measured by the
// stack (sonner measures a custom toast when its element changes, not when its content grows).
export function showCopyToast(jobId: string): void {
	if (getCopyJob(jobId) === undefined) {
		return
	}

	let id = showingIds.get(jobId)

	if (id === undefined) {
		showings += 1
		id = `copy:${jobId}:${String(showings)}`
		showingIds.set(jobId, id)
	}

	const toastId = id

	useCopyJobsStore.getState().update(jobId, job => (job.cardVisible ? job : { ...job, cardVisible: true }))

	toast.custom(
		() => (
			<CopyJobToast
				jobId={jobId}
				onHeightChange={() => {
					// A card already on its way out is not brought back.
					if (showingIds.get(jobId) === toastId) {
						showCopyToast(jobId)
					}
				}}
				onDismiss={() => {
					hideCopyToast(jobId)
				}}
				onRetried={retryId => {
					hideCopyToast(jobId)
					showCopyToast(retryId)
				}}
			/>
		),
		{
			id: toastId,
			duration: Infinity,
			// Every way the card goes away — its ✕, a swipe — ends here: the job keeps running, and a
			// settled one without a transfers row to reopen it is dropped. A card reopened before this
			// one finished leaving stays visible.
			onDismiss: () => {
				if (showingIds.get(jobId) === toastId) {
					showingIds.delete(jobId)
				}

				if (!showingIds.has(jobId)) {
					useCopyJobsStore.getState().update(jobId, job => ({ ...job, cardVisible: false }))
					pruneSettledCopyJobs()
				}
			}
		}
	)
}

export function hideCopyToast(jobId: string): void {
	const id = showingIds.get(jobId)

	if (id !== undefined) {
		showingIds.delete(jobId)
		toast.dismiss(id)
	}
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
