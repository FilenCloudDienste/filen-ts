import { showJobToast } from "@/features/transfers/lib/jobToast"
import { armPasswordPrompt } from "@/features/transfers/lib/extractPasswordPrompt"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { startCompress, startExtract } from "@/features/drive/lib/archiveJobs"
import type { CompressJobRequest, ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"

// Every compress and extract the user starts shows its card, as a copy does (copyToast.tsx). An extract
// started here also asks for its password by itself should it turn out to need one.

export function startCompressWithCard(request: Omit<CompressJobRequest, "id">, password: string | undefined): string {
	const id = startCompress(request, password)

	showJobToast(id)

	return id
}

export function startExtractWithCard(request: Omit<ExtractJobRequest, "id">, password: string | undefined): string {
	const id = startExtract(request, password)

	armPasswordPrompt(id)
	showJobToast(id)

	return id
}

// Batch extracts whose card is still to show once they end in something to look at. A password outcome
// is not that (the password prompt asks instead), so they stay watched through a rerun with one.
const cardless = new Set<string>()
let watchingCardless = false

function watchCardless(): void {
	if (watchingCardless) {
		return
	}

	watchingCardless = true

	useDriveJobsStore.subscribe((state, previous) => {
		if (state.jobs === previous.jobs || cardless.size === 0) {
			return
		}

		for (const jobId of cardless) {
			const job = state.jobs[jobId]

			if (job === previous.jobs[jobId]) {
				continue
			}

			if (job === undefined) {
				cardless.delete(jobId)

				continue
			}

			const status = job.outcome.status

			if (status === "doneWithIssues" || status === "failed" || status === "quotaExceeded") {
				cardless.delete(jobId)
				showJobToast(jobId)
			} else if (status === "done" || status === "cancelled") {
				cardless.delete(jobId)
			}
		}
	})
}

// Several archives at once, each its own job queued for the page's one archive slot. Only the first
// shows its card from the start: the rest are transfers rows until one ends in something to look at.
export function startExtractBatchWithCards(requests: readonly Omit<ExtractJobRequest, "id">[]): string[] {
	const ids: string[] = []

	for (const request of requests) {
		const id = startExtract(request, undefined)

		armPasswordPrompt(id)

		if (ids.length === 0) {
			showJobToast(id)
		} else {
			watchCardless()
			cardless.add(id)
		}

		ids.push(id)
	}

	return ids
}
