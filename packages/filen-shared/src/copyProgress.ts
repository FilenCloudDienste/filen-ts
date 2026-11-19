import { clampedRatio } from "./ratio"
import { runningPercent, runningShownBytes } from "./driveJobProgress"
import type { CopyJob } from "./copyJob"

// Pure reads of a copy job's progress, for whatever surface shows it.

type AnyCopyJob = CopyJob<unknown, unknown, unknown, unknown>

export function isCopyJobRunning(job: AnyCopyJob): boolean {
	return job.outcome.status === "running"
}

// 0-100 for the bar, or null while the total is still unknown (the scan), which renders indeterminate.
export function copyJobPercent(job: AnyCopyJob): number | null {
	if (job.outcome.status === "done") {
		return 100
	}

	const running = isCopyJobRunning(job)

	if (running && (job.phase === "scanning" || job.totals.bytes === 0)) {
		return null
	}

	return runningPercent(running, clampedRatio(job.counts.bytesDone, job.totals.bytes))
}

// A running copy is never shown complete. Its bytes count as each chunk uploads, but a file is done
// only once it is registered, so every byte can be up while files are still finalizing.
//
// The bytes a generic transfer row or bar is given for a copy, out of totals.bytes. While it runs they
// stay at or below 99% of the total, so a percent derived from them, however it rounds, reads at most 99.
export function copyJobShownBytes(job: AnyCopyJob): number {
	return runningShownBytes(isCopyJobRunning(job), job.totals.bytes, job.counts.bytesDone)
}

// A copy's speed and time left follow the rule every drive job shares.
export { jobRate as copyJobRate } from "./driveJob"
