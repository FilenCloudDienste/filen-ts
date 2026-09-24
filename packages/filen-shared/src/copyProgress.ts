import { clampedRatio } from "./ratio"
import type { CopyJob } from "./copyJob"

// Pure reads of a copy job's progress, for whatever surface shows it.

type AnyCopyJob = CopyJob<unknown, unknown, unknown, unknown>

export function isCopyJobRunning(job: AnyCopyJob): boolean {
	return job.outcome.status === "running"
}

// A running copy is never shown complete. Its bytes count as each chunk uploads, but a file is done
// only once it is registered, so every byte can be up while files are still finalizing.
const RUNNING_MAX_PERCENT = 99

// 0-100 for the bar, or null while the total is still unknown (the scan), which renders indeterminate.
export function copyJobPercent(job: AnyCopyJob): number | null {
	if (job.outcome.status === "done") {
		return 100
	}

	const running = isCopyJobRunning(job)

	if (running && (job.phase === "scanning" || job.totals.bytes === 0)) {
		return null
	}

	const percent = clampedRatio(job.counts.bytesDone, job.totals.bytes, 100)

	return running ? Math.min(percent, RUNNING_MAX_PERCENT) : percent
}

// The bytes a generic transfer row or bar is given for a copy, out of totals.bytes. While it runs they
// stay at or below 99% of the total, so a percent derived from them, however it rounds, reads at most 99.
export function copyJobShownBytes(job: AnyCopyJob): number {
	if (!isCopyJobRunning(job)) {
		return job.counts.bytesDone
	}

	return Math.min(job.counts.bytesDone, Math.floor((job.totals.bytes * RUNNING_MAX_PERCENT) / 100))
}

// Speed and time left only mean something while bytes are moving.
export function copyJobRate(job: AnyCopyJob): { bytesPerSecond: number; etaSeconds: number | null } | null {
	if (!isCopyJobRunning(job) || job.paused || job.pausing || job.bytesPerSecond === null || job.bytesPerSecond <= 0) {
		return null
	}

	return { bytesPerSecond: job.bytesPerSecond, etaSeconds: job.etaMs === null ? null : Math.ceil(job.etaMs / 1000) }
}
