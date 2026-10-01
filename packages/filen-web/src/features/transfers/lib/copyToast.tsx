import { toast } from "sonner"
import { CopyJobToast } from "@/features/transfers/components/copyJobToast"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { copyCardDuration } from "@/features/transfers/components/copyJobToast.logic"
import { pruneSettledCopyJobs, startCopy, startLinkedCopy } from "@/features/drive/lib/copy"
import { type CopyDestination, type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import type { AnyItemWithContext } from "@filen/sdk-rs"

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

	useCopyJobsStore.subscribe((state, previous) => {
		for (const jobId of showingIds.keys()) {
			const job = state.jobs[jobId]
			const before = previous.jobs[jobId]

			if (job !== undefined && before !== undefined && job !== before && copyCardDuration(job) !== copyCardDuration(before)) {
				showCopyToast(jobId)
			}
		}
	})
}

// A copy's progress card is a custom toast in the normal stack, sticky while its job runs and timed once it
// settled (copyCardDuration). Issuing it again while it shows only replaces its element and duration, which
// is also how a card that changed height gets re-measured by the stack (sonner measures a custom toast when
// its element changes, not when its content grows).
export function showCopyToast(jobId: string): void {
	const job = getCopyJob(jobId)

	if (job === undefined) {
		return
	}

	watchSettles()

	let id = showingIds.get(jobId)

	if (id === undefined) {
		showings += 1
		id = `copy:${jobId}:${String(showings)}`
		showingIds.set(jobId, id)
	}

	const toastId = id

	function onGone(): void {
		if (showingIds.get(jobId) === toastId) {
			showingIds.delete(jobId)
		}

		if (!showingIds.has(jobId)) {
			useCopyJobsStore.getState().update(jobId, job => ({ ...job, cardVisible: false }))
			pruneSettledCopyJobs()
		}
	}

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
			duration: copyCardDuration(job),
			// Every way the card goes away — its ✕, a swipe, its own timeout once settled — ends here: the
			// job keeps running, and a settled one without a transfers row to reopen it is dropped. A card
			// reopened before this one finished leaving stays visible.
			onDismiss: onGone,
			onAutoClose: onGone
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

// Every copy the user starts shows its card, before the job can settle, so even a quick copy ends on it.
export function startCopyWithCard(items: DriveItem[], destination: CopyDestination): string | null {
	const id = startCopy(items, destination)

	if (id !== null) {
		showCopyToast(id)
	}

	return id
}

export function startLinkedCopyWithCard(item: AnyItemWithContext, name: string, glyph: CopyJobGlyph, destination: CopyDestination): string {
	const id = startLinkedCopy(item, name, glyph, destination)

	showCopyToast(id)

	return id
}
