import { clampedRatio } from "./ratio"
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

	if (isCopyJobRunning(job) && (job.phase === "scanning" || job.totals.bytes === 0)) {
		return null
	}

	return clampedRatio(job.counts.bytesDone, job.totals.bytes, 100)
}

// Speed and time left only mean something while bytes are moving.
export function copyJobRate(job: AnyCopyJob): { bytesPerSecond: number; etaSeconds: number | null } | null {
	if (!isCopyJobRunning(job) || job.paused || job.pausing || job.bytesPerSecond === null || job.bytesPerSecond <= 0) {
		return null
	}

	return { bytesPerSecond: job.bytesPerSecond, etaSeconds: job.etaMs === null ? null : Math.ceil(job.etaMs / 1000) }
}
