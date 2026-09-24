import { clampedRatio } from "./ratio"
import type { CopyJob, CopyJobActiveFile, CopyJobCounts } from "./copyJob"

// Pure reads of a copy job's progress, for whatever surface shows it.

type AnyCopyJob = CopyJob<unknown, unknown, unknown, unknown>

// The files in flight count too, so progress moves with each chunk rather than only as whole files
// finish.
export function effectiveBytesDone(
	counts: Pick<CopyJobCounts, "bytesDone">,
	active: readonly Pick<CopyJobActiveFile, "bytesDone">[]
): number {
	let bytes = counts.bytesDone

	for (const file of active) {
		bytes += file.bytesDone
	}

	return bytes
}

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

	return clampedRatio(effectiveBytesDone(job.counts, job.active), job.totals.bytes, 100)
}

// Speed and time left only mean something while bytes are moving.
export function copyJobRate(job: AnyCopyJob): { bytesPerSecond: number; etaSeconds: number | null } | null {
	if (!isCopyJobRunning(job) || job.paused || job.pausing || job.bytesPerSecond === null || job.bytesPerSecond <= 0) {
		return null
	}

	return { bytesPerSecond: job.bytesPerSecond, etaSeconds: job.etaMs === null ? null : Math.ceil(job.etaMs / 1000) }
}
