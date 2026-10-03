import { toast } from "sonner"
import { RoutedDriveJobToast } from "@/features/transfers/components/driveJobToast"
import { jobCardDuration } from "@/features/transfers/components/driveJobCard.logic"
import { getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { pruneSettledDriveJobs } from "@/features/drive/lib/driveJobs"

// The toast id of each job's card while it is showing. A card reopened after being hidden gets a fresh
// id: a leaving toast stays in sonner's list for its exit animation, and a toast issued under the same
// id meanwhile is merged into it and leaves with it.
const showingIds = new Map<string, string>()
let showings = 0
let watchingSettles = false

// A showing card is issued again when its job settles (or starts doing something again), which is what
// swaps its sticky duration for the timed one. One subscription for every card, looking only at those
// showing.
function watchSettles(): void {
	if (watchingSettles) {
		return
	}

	watchingSettles = true

	useDriveJobsStore.subscribe((state, previous) => {
		for (const jobId of showingIds.keys()) {
			const job = state.jobs[jobId]
			const before = previous.jobs[jobId]

			if (job !== undefined && before !== undefined && job !== before && jobCardDuration(job) !== jobCardDuration(before)) {
				showJobToast(jobId)
			}
		}
	})
}

// A drive job's progress card is a custom toast in the normal stack, sticky while its job runs and timed
// once it settled (jobCardDuration). Issuing it again while it shows only replaces its element and
// duration, which is also how a card that changed height gets re-measured by the stack (sonner measures a
// custom toast when its element changes, not when its content grows).
export function showJobToast(jobId: string): void {
	const job = getDriveJob(jobId)

	if (job === undefined) {
		return
	}

	watchSettles()

	let id = showingIds.get(jobId)

	if (id === undefined) {
		showings += 1
		id = `${job.kind}:${jobId}:${String(showings)}`
		showingIds.set(jobId, id)
	}

	const toastId = id

	function onGone(): void {
		if (showingIds.get(jobId) === toastId) {
			showingIds.delete(jobId)
		}

		if (!showingIds.has(jobId)) {
			const gone = getDriveJob(jobId)

			if (gone !== undefined) {
				useDriveJobsStore.getState().update(gone.kind, jobId, job => (job.cardVisible ? { ...job, cardVisible: false } : job))
			}

			pruneSettledDriveJobs()
		}
	}

	useDriveJobsStore.getState().update(job.kind, jobId, job => (job.cardVisible ? job : { ...job, cardVisible: true }))

	toast.custom(
		() => (
			<RoutedDriveJobToast
				jobId={jobId}
				onHeightChange={() => {
					// A card already on its way out is not brought back.
					if (showingIds.get(jobId) === toastId) {
						showJobToast(jobId)
					}
				}}
				onDismiss={() => {
					hideJobToast(jobId)
				}}
				onRetried={retryId => {
					hideJobToast(jobId)
					showJobToast(retryId)
				}}
			/>
		),
		{
			id: toastId,
			duration: jobCardDuration(job),
			// Every way the card goes away — its ✕, a swipe, its own timeout once settled — ends here: the
			// job keeps running, and a settled one without a transfers row to reopen it is dropped. A card
			// reopened before this one finished leaving stays visible.
			onDismiss: onGone,
			onAutoClose: onGone
		}
	)
}

export function hideJobToast(jobId: string): void {
	const id = showingIds.get(jobId)

	if (id !== undefined) {
		showingIds.delete(jobId)
		toast.dismiss(id)
	}
}
