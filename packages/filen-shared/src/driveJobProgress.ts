import { clampedRatio } from "./ratio"
import { isJobRunning } from "./driveJob"
import type { CompressJob } from "./compressJob"
import type { ExtractJob } from "./extractJob"

// Pure reads of an archive job's progress, for whatever surface shows it. A running job is never shown
// complete, as a copy is not: its last files are still being registered.

type AnyCompressJob = CompressJob<unknown, unknown>
type AnyExtractJob = ExtractJob<unknown, unknown, unknown>

const RUNNING_MAX_PERCENT = 99

// The size and shown bytes a generic transfer row is given. While the job runs the shown bytes stay at
// or below 99% of the size, so a percent derived from them reads at most 99.
export interface JobRowFigures {
	size: number
	shown: number
}

function runningCap(running: boolean, size: number, shown: number): number {
	return running ? Math.min(shown, Math.floor((size * RUNNING_MAX_PERCENT) / 100)) : shown
}

function toPercent(running: boolean, fraction: number): number {
	const percent = Math.min(100, Math.max(0, fraction * 100))

	return running ? Math.min(percent, RUNNING_MAX_PERCENT) : percent
}

// Once the sources are read only the archive's upload and checks remain.
function compressReadFraction(job: AnyCompressJob): number | null {
	if (job.phase === "finishing" || job.phase === "verifying" || job.phase === "disposingSources") {
		return 1
	}

	if (job.totals.bytes > 0) {
		return clampedRatio(job.counts.bytesRead, job.totals.bytes)
	}

	// Only empty files: their count is all there is to measure.
	return job.totals.files > 0 ? clampedRatio(job.counts.filesDone, job.totals.files) : null
}

// Deleting the originals for good reads the archive back first, half of the work by the bar. Reading
// ends before verifying starts and the plan is fixed once the scan ends, so the fraction only grows.
function compressFraction(job: AnyCompressJob): number | null {
	const read = compressReadFraction(job)

	if (read === null || job.dispose !== "deletePermanently") {
		return read
	}

	const verified = job.counts.archiveBytes > 0 ? clampedRatio(job.counts.bytesVerified, job.counts.archiveBytes) : 0

	return (read + verified) / 2
}

// 0-100 for the bar, or null while the plan is still unknown or the job waits for the slot.
export function compressJobPercent(job: AnyCompressJob): number | null {
	if (job.outcome.status === "done") {
		return 100
	}

	const running = isJobRunning(job)

	if (running && (job.phase === "scanning" || job.phase === "waitingForWorker")) {
		return null
	}

	const fraction = compressFraction(job)

	if (fraction === null) {
		return running ? null : 0
	}

	return toPercent(running, fraction)
}

// The row reads "X of <source size>": the share of the work done, measured in the sources' bytes.
export function compressJobRowFigures(job: AnyCompressJob): JobRowFigures {
	const size = job.totals.bytes

	if (job.outcome.status === "done") {
		return { size, shown: size }
	}

	const running = isJobRunning(job)

	return { size, shown: runningCap(running, size, Math.floor(size * (compressFraction(job) ?? 0))) }
}

// The bytes done against the basis: failed bytes count too, as they are done with.
function plannedFraction(job: AnyExtractJob, basis: { bytes: number; files: number }): number | null {
	if (basis.bytes > 0) {
		return clampedRatio(job.counts.bytesDone + job.counts.bytesFailed, basis.bytes)
	}

	return basis.files > 0 ? clampedRatio(job.counts.filesDone + job.counts.filesFailed, basis.files) : null
}

function extractFraction(job: AnyExtractJob): number | null {
	switch (job.basis.type) {
		case "archiveRead":
			return job.archiveBytes > 0 ? clampedRatio(job.bytesRead, job.archiveBytes) : null
		case "planned":
			return plannedFraction(job, job.basis)
		case "unknown":
			return null
	}
}

// 0-100 for the bar, or null while waiting for the slot, reading the archive's index, or without a
// basis to measure against.
export function extractJobPercent(job: AnyExtractJob): number | null {
	if (job.outcome.status === "done") {
		return 100
	}

	const running = isJobRunning(job)

	if (running && (job.phase === "scanning" || job.phase === "waitingForWorker")) {
		return null
	}

	const fraction = extractFraction(job)

	return fraction === null ? null : toPercent(running, fraction)
}

// Without a basis the row has no size: it shows the bytes extracted alone.
export function extractJobRowFigures(job: AnyExtractJob): JobRowFigures {
	const { basis } = job

	if (basis.type === "unknown") {
		return { size: 0, shown: job.counts.bytesDone }
	}

	const size = basis.type === "archiveRead" ? job.archiveBytes : basis.bytes

	if (job.outcome.status === "done") {
		return { size, shown: size }
	}

	const shown = basis.type === "archiveRead" ? job.bytesRead : job.counts.bytesDone

	return { size, shown: runningCap(isJobRunning(job), size, shown) }
}
