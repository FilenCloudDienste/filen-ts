import { holdsArchiveSlot } from "@filen/shared"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"

// The page runs one archive job at a time and a paused one keeps its slot: the job a waiting listing can
// point the user to, or null when the slot's holder is simply running.
export function pausedSlotHolder(jobs: Iterable<DriveJob>): DriveJob | null {
	for (const job of jobs) {
		if (job.paused && holdsArchiveSlot(job)) {
			return job
		}
	}

	return null
}
