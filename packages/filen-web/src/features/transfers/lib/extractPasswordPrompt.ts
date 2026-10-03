import { useSyncExternalStore } from "react"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import type { ExtractJob } from "@/features/drive/lib/archiveJobs.logic"

// Which extract the password prompt (extractPasswordDialog.tsx) is for, and which wait their turn. Only a
// run started from this tab's UI is armed to open it by itself once it settles needing a password; any
// other (a retry of failed entries) only offers it on its card. The password itself never passes through
// here: it goes straight from the dialog's local state to the job's secret (jobSecrets.ts).

// Runs that may open the prompt once they settle needing a password.
const armed = new Set<string>()
// Replaced, never mutated, so a hook reading it re-renders on each change only.
let queue: readonly string[] = []
const queueListeners = new Set<() => void>()
let watching = false

export function needsExtractPassword(job: DriveJob | undefined): job is ExtractJob {
	return job?.kind === "extract" && (job.outcome.status === "passwordRequired" || job.outcome.status === "wrongPassword")
}

function setQueue(next: readonly string[]): void {
	if (next === queue) {
		return
	}

	queue = next

	for (const listener of queueListeners) {
		listener()
	}
}

function currentPromptId(): string | null {
	return useDriveJobsStore.getState().passwordPromptId
}

function offer(jobId: string): void {
	if (currentPromptId() === null) {
		useDriveJobsStore.getState().setPasswordPromptId(jobId)
	} else if (currentPromptId() !== jobId && !queue.includes(jobId)) {
		setQueue([...queue, jobId])
	}
}

// One subscription for every armed and queued run, looking only at those whose job object changed.
function watch(): void {
	if (watching) {
		return
	}

	watching = true

	useDriveJobsStore.subscribe((state, previous) => {
		if (state.jobs === previous.jobs || (armed.size === 0 && queue.length === 0)) {
			return
		}

		for (const jobId of armed) {
			const job = state.jobs[jobId]

			if (job === previous.jobs[jobId]) {
				continue
			}

			if (job?.outcome.status !== "running") {
				armed.delete(jobId)
			}

			if (needsExtractPassword(job)) {
				offer(jobId)
			}
		}

		// A queued run that no longer waits (rerun elsewhere, or gone) leaves its place.
		const stillWaiting = queue.filter(jobId => {
			const job = state.jobs[jobId]

			return job === previous.jobs[jobId] || needsExtractPassword(job)
		})

		if (stillWaiting.length !== queue.length) {
			setQueue(stillWaiting)
		}
	})
}

export function armPasswordPrompt(jobId: string): void {
	watch()
	armed.add(jobId)
}

// Asked for explicitly (a card's "Enter password"): now when no prompt is open, else next in line.
export function promptExtractPassword(jobId: string): void {
	watch()

	const current = currentPromptId()

	if (current === jobId) {
		return
	}

	if (current === null) {
		useDriveJobsStore.getState().setPasswordPromptId(jobId)

		return
	}

	setQueue([jobId, ...queue.filter(queued => queued !== jobId)])
}

// The current prompt is done with (answered or dismissed): the next run still waiting gets it.
export function closePasswordPrompt(): void {
	const jobs = useDriveJobsStore.getState().jobs
	let next: string | null = null
	let index = 0

	while (index < queue.length && next === null) {
		const jobId = queue[index]

		index += 1

		if (jobId !== undefined && needsExtractPassword(jobs[jobId])) {
			next = jobId
		}
	}

	setQueue(queue.slice(index))
	useDriveJobsStore.getState().setPasswordPromptId(next)
}

export function queuedPasswordPrompts(): readonly string[] {
	return queue
}

// The runs answered along with the current one ("apply to all") leave the line.
export function clearQueuedPasswordPrompts(): void {
	setQueue([])
}

function subscribeQueue(listener: () => void): () => void {
	queueListeners.add(listener)

	return () => {
		queueListeners.delete(listener)
	}
}

export function useQueuedPasswordPrompts(): readonly string[] {
	return useSyncExternalStore(subscribeQueue, queuedPasswordPrompts)
}
